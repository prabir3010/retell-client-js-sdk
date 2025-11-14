import { EventEmitter } from "eventemitter3";
import {
  DataPacket_Kind,
  RemoteParticipant,
  RemoteTrack,
  RemoteAudioTrack,
  RemoteTrackPublication,
  Room,
  RoomEvent,
  Track,
  createAudioAnalyser,
} from "livekit-client";

const hostUrl = "wss://retell-ai-4ihahnq7.livekit.cloud";
const decoder = new TextDecoder();

export interface StartCallConfig {
  accessToken: string;
  sampleRate?: number;
  captureDeviceId?: string; // specific sink id for audio capture device
  playbackDeviceId?: string; // specific sink id for audio playback device
  emitRawAudioSamples?: boolean; // receive raw float32 audio samples (ex. for animation). Default to false.
  simulationMode?: boolean; // If true, disables microphone and allows custom audio publishing
}

export class RetellWebClient extends EventEmitter {
  // Room related
  private room: Room;
  private connected: boolean = false;

  // Helper nodes and variables to analyze and animate based on audio
  public isAgentTalking: boolean = false;

  // Analyser node for agent audio, only available when
  // emitRawAudioSamples is true. Can directly use / modify this for visualization.
  // contains a calculateVolume helper method to get the current volume.
  public analyzerComponent: {
    calculateVolume: () => number;
    analyser: AnalyserNode;
    cleanup: () => Promise<void>;
  };
  private captureAudioFrame: number;
  
  // AudioContext for simulation mode - reused across multiple sendAudioBuffer calls
  private audioContext?: AudioContext;
  
  // Track counter for unique track names
  private audioTrackCounter: number = 0;
  
  // Store current audio track publication for cleanup
  private currentAudioPublication?: any;

  constructor() {
    super();
  }

  public async startCall(startCallConfig: StartCallConfig): Promise<void> {
    try {
      // Room options

      console.log("startCallConfig v1");
      this.room = new Room({
        audioCaptureDefaults: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1, // always mono for input
          deviceId: startCallConfig.captureDeviceId,
          sampleRate: startCallConfig.sampleRate,
        },
        audioOutput: {
          deviceId: startCallConfig.playbackDeviceId,
        },
      });

      // Register handlers
      this.handleRoomEvents();
      this.handleAudioEvents(startCallConfig);
      this.handleDataEvents();

      // Connect to room
      await this.room.connect(hostUrl, startCallConfig.accessToken);
      console.log("connected to room", this.room.name);

      // Turns microphone track on (unless in simulation mode)
      if (!startCallConfig.simulationMode) {
        this.room.localParticipant.setMicrophoneEnabled(true);
      } else {
        // Create AudioContext once for simulation mode
        this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
          sampleRate: 24000
        });
      }
      this.connected = true;
      this.emit("call_started");
    } catch (err) {
      this.emit("error", "Error starting call");
      console.error("Error starting call", err);
      // Cleanup
      this.stopCall();
    }
  }

  // Optional.
  // Some browser does not support audio playback without user interaction
  // Call this function inside a click/tap handler to start audio playback
  public async startAudioPlayback() {
    await this.room.startAudio();
  }

  public stopCall(): void {
    if (!this.connected) return;
    // Cleanup variables and disconnect from room
    this.connected = false;
    this.emit("call_ended");
    this.room?.disconnect();

    this.isAgentTalking = false;
    delete this.room;

    if (this.analyzerComponent) {
      this.analyzerComponent.cleanup();
      delete this.analyzerComponent;
    }

    if (this.captureAudioFrame) {
      window.cancelAnimationFrame(this.captureAudioFrame);
      delete this.captureAudioFrame;
    }

    // Unpublish current audio track if it exists
    if (this.currentAudioPublication) {
      try {
        this.room.localParticipant.unpublishTrack(this.currentAudioPublication.track);
      } catch (err) {
        console.warn("Error unpublishing track on stopCall", err);
      }
      delete this.currentAudioPublication;
    }

    // Close AudioContext if it exists
    if (this.audioContext && this.audioContext.state !== "closed") {
      this.audioContext.close();
      delete this.audioContext;
    }

    // Reset counter
    this.audioTrackCounter = 0;
  }

  public mute(): void {
    if (this.connected) this.room.localParticipant.setMicrophoneEnabled(false);
  }

  public unmute(): void {
    if (this.connected) this.room.localParticipant.setMicrophoneEnabled(true);
  }

  /**
   * Send audio chunk (PCM Int16Array) progressively for streaming
   * This allows sending audio as it's generated, improving VAD and turn-taking
   * @param pcmChunk Int16Array of PCM audio data at 24kHz
   */
  public async sendAudioChunk(pcmChunk: Int16Array): Promise<void> {
    if (!this.connected) {
      throw new Error("Cannot send audio chunk: not connected to call");
    }

    if (!this.audioContext) {
      throw new Error("AudioContext not initialized. Make sure to set simulationMode: true in startCall()");
    }

    try {
      // Resume AudioContext if suspended
      if (this.audioContext.state === "suspended") {
        await this.audioContext.resume();
      }

      // Convert PCM Int16Array to Float32Array
      const float32Data = new Float32Array(pcmChunk.length);
      for (let i = 0; i < pcmChunk.length; i++) {
        float32Data[i] = pcmChunk[i] / 32768.0;
      }

      // Create AudioBuffer from the chunk
      const audioBuffer = this.audioContext.createBuffer(1, float32Data.length, 24000);
      const channelData = audioBuffer.getChannelData(0);
      channelData.set(float32Data);

      // Create buffer source node
      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;

      // Create destination node
      const destination = this.audioContext.createMediaStreamDestination();
      source.connect(destination);

      // Get audio track
      const mediaStream = destination.stream;
      const audioTrack = mediaStream.getAudioTracks()[0];

      if (!audioTrack) {
        throw new Error("Failed to create audio track from chunk");
      }

      // For streaming, we reuse the same track name
      const trackName = "simulated_audio_stream";

      // Only publish if we don't have a current publication, or unpublish and republish
      if (!this.currentAudioPublication) {
        const publication = await this.room.localParticipant.publishTrack(audioTrack, {
          name: trackName,
          source: Track.Source.Microphone,
        });
        this.currentAudioPublication = publication;
        console.log(`📤 Published streaming track (${trackName})`);
      }

      // Start playback of this chunk
      source.start(0);

      // Wait for chunk to finish playing
      await new Promise<void>((resolve) => {
        source.onended = () => {
          // Disconnect nodes
          try {
            source.disconnect();
            destination.disconnect();
          } catch (err) {
            // Already disconnected
          }
          audioTrack.stop();
          resolve();
        };
      });
    } catch (err) {
      console.error("Error sending audio chunk", err);
      throw err;
    }
  }

  public async sendAudioBuffer(audioBuffer: AudioBuffer): Promise<void> {
    if (!this.connected) {
      throw new Error("Cannot send audio buffer: not connected to call");
    }

    if (!this.audioContext) {
      throw new Error("AudioContext not initialized. Make sure to set simulationMode: true in startCall()");
    }

    try {
      // Unpublish previous track if it exists to avoid conflicts
      if (this.currentAudioPublication) {
        try {
          await this.room.localParticipant.unpublishTrack(this.currentAudioPublication.track);
          console.log("Unpublished previous audio track");
        } catch (err) {
          console.warn("Error unpublishing previous track", err);
        }
        this.currentAudioPublication = undefined;
      }

      // Resume AudioContext if suspended (browser autoplay policy)
      if (this.audioContext.state === "suspended") {
        await this.audioContext.resume();
      }

      // Create buffer source node from reused AudioContext
      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;

      // Create destination node to get MediaStream
      const destination = this.audioContext.createMediaStreamDestination();

      // Connect source to destination
      source.connect(destination);

      // Get the MediaStream from the destination
      const mediaStream = destination.stream;
      const audioTrack = mediaStream.getAudioTracks()[0];

      if (!audioTrack) {
        throw new Error("Failed to create audio track from buffer");
      }

      // Generate unique track name to avoid conflicts
      const trackName = `simulated_audio_${this.audioTrackCounter++}`;

      // Publish the track to the room
      const publication = await this.room.localParticipant.publishTrack(audioTrack, {
        name: trackName,
        source: Track.Source.Microphone,
      });

      // Store publication for cleanup before next call
      this.currentAudioPublication = publication;

      console.log(`Publishing audio buffer to call (${trackName})`);

      // Delay to let LiveKit and Retell's VAD initialize the track properly
      // This prevents turn-taking confusion and premature agent responses
      await new Promise(resolve => setTimeout(resolve, 400));

      // Start playback
      source.start(0);

      // Cleanup after playback completes
      return new Promise((resolve, reject) => {
        let timeoutId: number | null = null;
        let isCleanedUp = false;

        const cleanup = async (isError: boolean = false) => {
          if (isCleanedUp) return;
          isCleanedUp = true;

          // Clear timeout if it exists
          if (timeoutId !== null) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }

          try {
            // Disconnect audio nodes BEFORE stopping track to prevent node accumulation
            source.disconnect();
            destination.disconnect();
            
            // Stop the track
            audioTrack.stop();
            
            // Note: We do NOT unpublish here - that happens at the start of the next sendAudioBuffer call
            // or when stopCall() is called. This prevents race conditions.
            
            // Note: We do NOT close the AudioContext here - it's reused for subsequent calls
            // The AudioContext is only closed when stopCall() is called
            
            if (isError) {
              reject(new Error("Audio buffer playback timeout"));
            } else {
              console.log("Audio buffer playback completed");
              resolve();
            }
          } catch (err) {
            console.error("Error cleaning up audio buffer", err);
            reject(err);
          }
        };

        source.onended = () => cleanup(false);

        // Safety timeout
        timeoutId = window.setTimeout(() => {
          console.warn("Audio buffer playback timeout");
          cleanup(true);
        }, (audioBuffer.duration + 5) * 1000);
      });
    } catch (err) {
      console.error("Error sending audio buffer", err);
      throw err;
    }
  }

  private captureAudioSamples() {
    if (!this.connected || !this.analyzerComponent) return;
    let bufferLength = this.analyzerComponent.analyser.fftSize;
    let dataArray = new Float32Array(bufferLength);
    this.analyzerComponent.analyser.getFloatTimeDomainData(dataArray);
    this.emit("audio", dataArray);
    this.captureAudioFrame = window.requestAnimationFrame(() =>
      this.captureAudioSamples(),
    );
  }

  private handleRoomEvents(): void {
    this.room.on(
      RoomEvent.ParticipantDisconnected,
      (participant: RemoteParticipant) => {
        if (participant?.identity === "server") {
          // Agent hang up, wait 500ms to hangup call to avoid cutoff last bit of audio
          setTimeout(() => {
            this.stopCall();
          }, 500);
        }
      },
    );

    this.room.on(RoomEvent.Disconnected, () => {
      // room disconnected
      this.stopCall();
    });
  }

  private handleAudioEvents(startCallConfig: StartCallConfig): void {
    this.room.on(
      RoomEvent.TrackSubscribed,
      (
        track: RemoteTrack,
        publication: RemoteTrackPublication,
        participant: RemoteParticipant,
      ) => {
        if (
          track.kind === Track.Kind.Audio &&
          track instanceof RemoteAudioTrack
        ) {
          if (publication.trackName === "agent_audio") {
            // this is where the agent can start playback
            // can be used to stop loading animation
            this.emit("call_ready");

            if (startCallConfig.emitRawAudioSamples) {
              this.analyzerComponent = createAudioAnalyser(track);
              this.captureAudioFrame = window.requestAnimationFrame(() =>
                this.captureAudioSamples(),
              );
            }
          }

          // Start playing audio for subscribed tracks
          track.attach();
        }
      },
    );
  }

  private handleDataEvents(): void {
    this.room.on(
      RoomEvent.DataReceived,
      (
        payload: Uint8Array,
        participant?: RemoteParticipant,
        kind?: DataPacket_Kind,
        topic?: string,
      ) => {
        try {
          // parse server data
          if (participant?.identity !== "server") return;

          let decodedData = decoder.decode(payload);
          let event = JSON.parse(decodedData);
          if (event.event_type === "update") {
            this.emit("update", event);
          } else if (event.event_type === "metadata") {
            this.emit("metadata", event);
          } else if (event.event_type === "agent_start_talking") {
            this.isAgentTalking = true;
            this.emit("agent_start_talking");
          } else if (event.event_type === "agent_stop_talking") {
            this.isAgentTalking = false;
            this.emit("agent_stop_talking");
          } else if (event.event_type === "node_transition") {
            this.emit("node_transition", event);
          }
        } catch (err) {
          console.error("Error decoding data received", err);
        }
      },
    );
  }
}

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
   * Send audio buffer by simulating real microphone input (progressive chunks)
   * This mimics how a real microphone sends audio progressively, not all at once
   * This is crucial for Retell's VAD and turn-taking to work properly
   */
  public async sendAudioBuffer(audioBuffer: AudioBuffer): Promise<void> {
    if (!this.connected) {
      throw new Error("Cannot send audio buffer: not connected to call");
    }

    if (!this.audioContext) {
      throw new Error("AudioContext not initialized. Make sure to set simulationMode: true in startCall()");
    }

    try {
      // Unpublish previous track if exists
      if (this.currentAudioPublication) {
        try {
          await this.room.localParticipant.unpublishTrack(this.currentAudioPublication.track);
          console.log("Unpublished previous audio track");
        } catch (err) {
          console.warn("Error unpublishing previous track", err);
        }
        this.currentAudioPublication = undefined;
      }

      // Resume AudioContext if suspended
      if (this.audioContext.state === "suspended") {
        await this.audioContext.resume();
      }

      console.log(`Starting progressive audio streaming (${audioBuffer.duration.toFixed(2)}s)`);

      // Create MediaStream destination
      const destination = this.audioContext.createMediaStreamDestination();
      const mediaStream = destination.stream;
      const audioTrack = mediaStream.getAudioTracks()[0];

      if (!audioTrack) {
        throw new Error("Failed to create audio track");
      }

      // Publish track once
      const trackName = `simulated_audio_${this.audioTrackCounter++}`;
      const publication = await this.room.localParticipant.publishTrack(audioTrack, {
        name: trackName,
        source: Track.Source.Microphone,
      });
      this.currentAudioPublication = publication;

      console.log(`Published progressive audio track (${trackName})`);

      // Small delay for VAD initialization
      await new Promise(resolve => setTimeout(resolve, 200));

      // Send audio progressively in small chunks (simulating real mic)
      await this.sendAudioProgressively(audioBuffer, destination);

      // Cleanup
      destination.disconnect();
      audioTrack.stop();

      console.log("Progressive audio streaming completed");
    } catch (err) {
      console.error("Error sending audio buffer", err);
      throw err;
    }
  }

  /**
   * Send audio buffer progressively in small chunks to simulate real microphone
   * This is KEY for proper Retell VAD and turn-taking behavior
   */
  private async sendAudioProgressively(
    audioBuffer: AudioBuffer,
    destination: MediaStreamAudioDestinationNode
  ): Promise<void> {
    const sampleRate = audioBuffer.sampleRate;
    const channelData = audioBuffer.getChannelData(0);
    
    // Chunk size: 20ms of audio (mimics real-time mic input)
    const chunkDurationMs = 20;
    const chunkSizeInSamples = Math.floor((sampleRate * chunkDurationMs) / 1000);
    
    const totalSamples = channelData.length;
    const numChunks = Math.ceil(totalSamples / chunkSizeInSamples);
    
    console.log(`  Sending ${numChunks} chunks (${chunkDurationMs}ms each)...`);

    let offset = 0;
    const startTime = this.audioContext!.currentTime;

    for (let i = 0; i < numChunks; i++) {
      const chunkSize = Math.min(chunkSizeInSamples, totalSamples - offset);
      
      // Create small buffer for this chunk
      const chunkBuffer = this.audioContext!.createBuffer(
        1,
        chunkSize,
        sampleRate
      );
      
      // Copy chunk data
      const chunkChannelData = chunkBuffer.getChannelData(0);
      for (let j = 0; j < chunkSize; j++) {
        chunkChannelData[j] = channelData[offset + j];
      }
      
      // Create source for this chunk
      const source = this.audioContext!.createBufferSource();
      source.buffer = chunkBuffer;
      source.connect(destination);
      
      // Schedule this chunk to play at the right time
      const playTime = startTime + (i * chunkDurationMs) / 1000;
      source.start(playTime);
      
      offset += chunkSize;
      
      // Wait for chunk duration before sending next chunk (real-time simulation)
      await new Promise(resolve => setTimeout(resolve, chunkDurationMs));
    }

    // Wait for final chunk to finish playing
    const finalChunkDuration = ((totalSamples % chunkSizeInSamples) || chunkSizeInSamples) / sampleRate * 1000;
    await new Promise(resolve => setTimeout(resolve, finalChunkDuration + 100));
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

# Retell Client JS SDK

JavaScript SDK for integrating Retell AI voice calls into web applications.

Check out [Retell AI Web Call Guide](https://docs.retellai.com/make-calls/web-call) for the official documentation.

## Installation

```bash
npm install retell-client-js-sdk
```

## Basic Usage

### Standard Microphone-Based Call

```javascript
import { RetellWebClient } from "retell-client-js-sdk";

const retellClient = new RetellWebClient();

// Start a call with microphone input
await retellClient.startCall({
  accessToken: "your-access-token",
  sampleRate: 24000,
  emitRawAudioSamples: false
});

// Listen for events
retellClient.on("call_started", () => {
  console.log("Call started");
});

retellClient.on("agent_start_talking", () => {
  console.log("Agent is speaking");
});

retellClient.on("agent_stop_talking", () => {
  console.log("Agent finished speaking");
});

retellClient.on("call_ended", () => {
  console.log("Call ended");
});

// Stop the call
retellClient.stopCall();
```

## Simulation Mode (Custom Audio Buffer Playback)

The SDK now supports **simulation mode** for end-to-end testing, allowing you to send pre-recorded or TTS-generated audio instead of using the microphone.

### Use Case: Automated Testing with ElevenLabs TTS

Perfect for simulating conversations with the Retell agent for testing purposes.

### How It Works

1. **Start call in simulation mode** (disables microphone)
2. **Listen for agent audio** and transcribe with STT (e.g., Deepgram)
3. **When agent stops talking**, validate the transcript
4. **Generate TTS response** (e.g., ElevenLabs)
5. **Send AudioBuffer** to Retell call using `sendAudioBuffer()`

### Complete Example

```javascript
import { RetellWebClient } from "retell-client-js-sdk";

const retellClient = new RetellWebClient();

// Configuration
const elevenLabsApiKey = "your-elevenlabs-api-key";
const elevenLabsVoiceId = "your-voice-id";
let agentTranscriptBuffer = [];

// Start call in simulation mode
await retellClient.startCall({
  accessToken: "your-retell-access-token",
  sampleRate: 24000,
  emitRawAudioSamples: true, // Enable to receive agent audio for STT
  simulationMode: true // Disables microphone, enables custom audio
});

// Optional: Start audio playback (required by some browsers)
await retellClient.startAudioPlayback();

// Listen for agent audio and send to STT
retellClient.on("audio", async (audioData) => {
  // audioData is Float32Array PCM samples
  // Send to Deepgram or other STT service
  const transcript = await sendToDeepgramSTT(audioData);
  if (transcript) {
    agentTranscriptBuffer.push(transcript);
  }
});

// When agent stops talking, validate and respond
retellClient.on("agent_stop_talking", async () => {
  try {
    // 1. Get full transcript
    const agentMessage = agentTranscriptBuffer.join(" ");
    agentTranscriptBuffer = []; // Reset buffer
    
    console.log("Agent said:", agentMessage);
    
    // 2. Validate or generate response based on your test logic
    const responseText = generateTestResponse(agentMessage);
    
    // 3. Generate TTS with ElevenLabs
    const audioBuffer = await generateElevenLabsAudio(responseText);
    
    // 4. Send audio to Retell call
    await retellClient.sendAudioBuffer(audioBuffer);
    
    console.log("Sent simulated user response");
  } catch (error) {
    console.error("Error processing agent response:", error);
  }
});

// Helper function: Generate audio from ElevenLabs
async function generateElevenLabsAudio(text) {
  // Call ElevenLabs TTS API
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${elevenLabsVoiceId}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": elevenLabsApiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text: text,
        model_id: "eleven_turbo_v2"
      })
    }
  );
  
  if (!response.ok) {
    throw new Error(`ElevenLabs API error: ${response.status}`);
  }
  
  // Get audio blob
  const audioBlob = await response.blob();
  
  // Decode to AudioBuffer (must match Retell's 24kHz sample rate)
  const audioContext = new AudioContext({ sampleRate: 24000 });
  const arrayBuffer = await audioBlob.arrayBuffer();
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
  
  // Clean up
  await audioContext.close();
  
  return audioBuffer;
}

// Helper function: Example test response logic
function generateTestResponse(agentMessage) {
  // Your validation and response logic here
  if (agentMessage.includes("name")) {
    return "My name is John";
  } else if (agentMessage.includes("help")) {
    return "I need assistance with my account";
  } else {
    return "Yes, that sounds good";
  }
}

// Helper function: Send audio to Deepgram STT
async function sendToDeepgramSTT(audioData) {
  // Implement your Deepgram integration here
  // Convert Float32Array to format Deepgram expects
  // Return transcript text
}
```

## API Reference

### `RetellWebClient`

#### Methods

##### `startCall(config: StartCallConfig): Promise<void>`

Starts a call with the Retell agent.

**StartCallConfig Options:**
- `accessToken` (string, required): Authentication token from Retell API
- `sampleRate` (number, optional): Audio sample rate in Hz (default: 24000)
- `captureDeviceId` (string, optional): Specific microphone device ID
- `playbackDeviceId` (string, optional): Specific speaker device ID
- `emitRawAudioSamples` (boolean, optional): Enable `audio` event with Float32Array samples (default: false)
- `simulationMode` (boolean, optional): Disable microphone, enable custom audio publishing (default: false)

##### `sendAudioBuffer(audioBuffer: AudioBuffer): Promise<void>`

Send custom audio to the Retell call. Only works when `simulationMode: true`.

**Parameters:**
- `audioBuffer` (AudioBuffer): Web Audio API AudioBuffer containing the audio to send

**Returns:** Promise that resolves when audio playback completes

**Important Notes:**
- AudioBuffer must be at 24kHz sample rate (or will be resampled)
- The method automatically handles track publishing, playback, and cleanup
- Waits for audio to finish playing before resolving
- Automatically unpublishes the track after playback

##### `startAudioPlayback(): Promise<void>`

Manually start audio playback. Required by some browsers that block autoplay.

##### `stopCall(): void`

Ends the current call and cleans up resources.

##### `mute(): void`

Mutes the microphone (only applicable when not in simulation mode).

##### `unmute(): void`

Unmutes the microphone (only applicable when not in simulation mode).

#### Events

Listen to events using `retellClient.on(eventName, callback)`.

##### `call_started`

Emitted when the call successfully starts.

```javascript
retellClient.on("call_started", () => {
  console.log("Call has started");
});
```

##### `call_ready`

Emitted when the agent audio track is ready for playback.

```javascript
retellClient.on("call_ready", () => {
  console.log("Agent is ready to speak");
});
```

##### `call_ended`

Emitted when the call ends.

```javascript
retellClient.on("call_ended", () => {
  console.log("Call has ended");
});
```

##### `agent_start_talking`

Emitted when the agent starts speaking.

```javascript
retellClient.on("agent_start_talking", () => {
  console.log("Agent started talking");
});
```

##### `agent_stop_talking`

Emitted when the agent stops speaking.

```javascript
retellClient.on("agent_stop_talking", () => {
  console.log("Agent stopped talking");
  // Ideal time to send your simulated response
});
```

##### `audio`

Emitted continuously with raw audio samples when `emitRawAudioSamples: true`.

**Callback parameter:** `Float32Array` - PCM audio samples

```javascript
retellClient.on("audio", (audioData) => {
  // audioData is Float32Array of PCM samples
  // Send to STT service or use for visualization
});
```

##### `update`

Emitted when receiving updates from the Retell server.

```javascript
retellClient.on("update", (event) => {
  console.log("Update:", event);
});
```

##### `metadata`

Emitted when receiving metadata from the Retell server.

```javascript
retellClient.on("metadata", (event) => {
  console.log("Metadata:", event);
});
```

##### `error`

Emitted when an error occurs.

```javascript
retellClient.on("error", (error) => {
  console.error("Error:", error);
});
```

## Best Practices for Simulation Mode

1. **Sample Rate**: Always use 24kHz sample rate for both the call and your AudioBuffers
2. **Timing**: Wait for `agent_stop_talking` before sending your audio response
3. **Error Handling**: Wrap `sendAudioBuffer()` in try-catch blocks
4. **Cleanup**: The SDK automatically cleans up audio resources after playback
5. **Testing**: Use simulation mode for automated end-to-end conversation testing

## Example: Multi-Turn Testing

```javascript
const conversationScript = [
  { expected: "name", response: "My name is Alice" },
  { expected: "help", response: "I need to reset my password" },
  { expected: "email", response: "alice@example.com" }
];

let turnIndex = 0;

retellClient.on("agent_stop_talking", async () => {
  if (turnIndex >= conversationScript.length) {
    console.log("Test complete");
    retellClient.stopCall();
    return;
  }
  
  const turn = conversationScript[turnIndex];
  const responseText = turn.response;
  
  // Generate and send audio
  const audioBuffer = await generateElevenLabsAudio(responseText);
  await retellClient.sendAudioBuffer(audioBuffer);
  
  turnIndex++;
});
```

## Troubleshooting

### Audio Not Playing
- Call `startAudioPlayback()` after user interaction if browser blocks autoplay
- Ensure sample rate is 24kHz

### Microphone Still Active in Simulation Mode
- Verify `simulationMode: true` is set in `startCall()` config

### AudioBuffer Playback Fails
- Check that AudioBuffer is properly decoded
- Ensure AudioContext sample rate matches (24kHz)
- Verify call is connected before calling `sendAudioBuffer()`

## License

See LICENSE file for details.

import { EventEmitter } from "eventemitter3";
export interface StartCallConfig {
    accessToken: string;
    sampleRate?: number;
    captureDeviceId?: string;
    playbackDeviceId?: string;
    emitRawAudioSamples?: boolean;
    simulationMode?: boolean;
}
export declare class RetellWebClient extends EventEmitter {
    private room;
    private connected;
    isAgentTalking: boolean;
    analyzerComponent: {
        calculateVolume: () => number;
        analyser: AnalyserNode;
        cleanup: () => Promise<void>;
    };
    private captureAudioFrame;
    private audioContext?;
    constructor();
    startCall(startCallConfig: StartCallConfig): Promise<void>;
    startAudioPlayback(): Promise<void>;
    stopCall(): void;
    mute(): void;
    unmute(): void;
    sendAudioBuffer(audioBuffer: AudioBuffer): Promise<void>;
    private captureAudioSamples;
    private handleRoomEvents;
    private handleAudioEvents;
    private handleDataEvents;
}

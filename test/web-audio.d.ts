// Only the part of Web Audio that public/speech.ts uses. This tsconfig has no DOM library (adding
// it changes the types of fetch and Response for every test), and the player is browser code.

interface AudioBuffer {
  readonly duration: number;
  copyToChannel(source: Float32Array, channelNumber: number): void;
}

interface AudioBufferSourceNode {
  buffer: AudioBuffer | null;
  onended: (() => void) | null;
  connect(destination: unknown): void;
  start(when?: number): void;
  stop(): void;
}

declare class AudioContext {
  readonly currentTime: number;
  readonly destination: unknown;
  readonly state: string;
  addEventListener(type: "statechange", listener: () => void): void;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer;
  createBufferSource(): AudioBufferSourceNode;
}

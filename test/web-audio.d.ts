// Only the part of Web Audio that public/speech.ts uses. This tsconfig has no DOM library (adding
// it changes the types of fetch and Response for every test), and the player is browser code.

interface AudioBuffer {
  readonly duration: number;
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
  resume(): Promise<void>;
  suspend(): Promise<void>;
  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>;
  createBufferSource(): AudioBufferSourceNode;
}

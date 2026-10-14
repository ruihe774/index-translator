// Recording a voice sample from the microphone, and writing it as WAV. No DOM types here, so the
// logic can be tested with fakes under bun test; voice-sample.ts adds the browser-only parts.

/** Longer samples are cut: the model uses a few seconds, and the upload stays small. */
export const MAX_SAMPLE_SECONDS = 30;
/** Shorter ones carry too little of the voice. */
export const MIN_SAMPLE_SECONDS = 1;

export function encodeWav(samples: Float32Array, rate: number): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(at + i, text.charCodeAt(i));
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x80_00 : v * 0x7f_ff, true);
  }
  return view.buffer;
}

/** The parts of MediaStream, MediaRecorder and navigator.mediaDevices that are used. */
export interface MicStream {
  getTracks(): { stop(): void }[];
}
export interface MicMediaRecorder {
  readonly state: string;
  readonly mimeType: string;
  readonly stream: MicStream;
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}
export interface MicDeps {
  mediaDevices?: { getUserMedia?: (constraints: { audio: boolean }) => Promise<MicStream> };
  MediaRecorder?: new (stream: MicStream) => MicMediaRecorder;
  /** Recording length that triggers `onLimit`. */
  limitMs?: number;
}

function stopTracks(stream: MicStream | undefined) {
  for (const t of stream?.getTracks() ?? []) {
    try {
      t.stop();
    } catch {}
  }
}

function micProblem(e: unknown): Error {
  const name = (e as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new Error("Microphone access was denied. Allow it for this page to record.");
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return new Error("No microphone was found.");
  }
  return e instanceof Error ? e : new Error(String(e));
}

export class MicRecorder {
  private recorder: MicMediaRecorder | null = null;
  private chunks: Blob[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private opening = false;
  private pending: Promise<ArrayBuffer> | null = null;

  constructor(private readonly deps: MicDeps = {}) {}

  /** True while a recording runs. */
  get recording(): boolean {
    return this.recorder !== null && this.recorder.state === "recording";
  }

  /** True while the microphone is being opened (the permission prompt may be showing). */
  get starting(): boolean {
    return this.opening;
  }

  /** True from the moment `stop` is called until the recording has been read out. */
  get stopping(): boolean {
    return this.pending !== null;
  }

  async start(onLimit: () => void): Promise<void> {
    const g = globalThis as unknown as {
      navigator?: { mediaDevices?: MicDeps["mediaDevices"] };
      MediaRecorder?: MicDeps["MediaRecorder"];
    };
    const devices = this.deps.mediaDevices ?? g.navigator?.mediaDevices;
    const Recorder = this.deps.MediaRecorder ?? g.MediaRecorder;
    const getUserMedia = devices?.getUserMedia?.bind(devices);
    if (!getUserMedia || !Recorder) {
      throw new Error("This browser cannot record from a microphone here (it needs a secure page).");
    }
    if (this.opening || this.recorder || this.pending) {
      throw new Error("Already recording.");
    }
    this.opening = true;
    try {
      let stream: MicStream;
      try {
        stream = await getUserMedia({ audio: true });
      } catch (e) {
        throw micProblem(e);
      }
      try {
        const chunks: Blob[] = [];
        this.chunks = chunks;
        const recorder = new Recorder(stream);
        recorder.ondataavailable = (e) => {
          if (e.data.size) {
            chunks.push(e.data);
          }
        };
        recorder.start();
        this.recorder = recorder;
      } catch (e) {
        stopTracks(stream); // the microphone indicator must go out
        throw micProblem(e);
      }
      this.timer = setTimeout(onLimit, this.deps.limitMs ?? MAX_SAMPLE_SECONDS * 1000);
    } finally {
      this.opening = false;
    }
  }

  /** Ends the recording and returns what was captured. Calling it again meanwhile returns the same result. */
  stop(): Promise<ArrayBuffer> {
    if (this.pending) {
      return this.pending;
    }
    clearTimeout(this.timer);
    const { recorder } = this;
    if (!recorder) {
      return Promise.reject(new Error("Not recording."));
    }
    this.recorder = null;
    const { chunks } = this;
    const done = new Promise<ArrayBuffer>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        stopTracks(recorder.stream);
        if (error) {
          return reject(error instanceof Error ? error : new Error("The recording failed."));
        }
        new Blob(chunks, { type: recorder.mimeType }).arrayBuffer().then(resolve, reject);
      };
      recorder.onstop = () => finish();
      recorder.onerror = () => finish(new Error("The recording failed."));
      if (recorder.state === "inactive") {
        return finish();
      } // the browser already ended it
      try {
        recorder.stop();
      } catch (e) {
        finish(e);
      }
    });
    const clear = () => {
      this.pending = null;
    };
    this.pending = done;
    done.then(clear, clear);
    return done;
  }
}

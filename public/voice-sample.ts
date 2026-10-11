// Voice samples for cloning: any audio the browser can decode (a file, or a microphone recording)
// becomes a mono 16-bit WAV that the server hands to the speech model as the reference voice.

const RATE = 24_000;
/** Longer samples are cut: the model uses a few seconds, and the upload stays small. */
export const MAX_SAMPLE_SECONDS = 30;
/** Shorter ones carry too little of the voice. */
export const MIN_SAMPLE_SECONDS = 1;

export function encodeWav(samples: Float32Array, rate: number): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
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
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return view.buffer;
}

/** Decodes audio of any format the browser knows, mixes it to mono, resamples and trims it. */
export async function audioToWav(data: ArrayBuffer): Promise<ArrayBuffer> {
  const ctx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(data);
  } catch {
    throw new Error("This file is not audio the browser can read.");
  } finally {
    void ctx.close();
  }
  if (decoded.duration < MIN_SAMPLE_SECONDS) throw new Error("The sample is too short; use at least a few seconds.");
  const length = Math.round(Math.min(decoded.duration, MAX_SAMPLE_SECONDS) * RATE);
  const offline = new OfflineAudioContext(1, length, RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded; // channels are mixed down to the one output channel
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return encodeWav(rendered.getChannelData(0), RATE);
}

export async function uploadVoice(api: string, name: string, wav: ArrayBuffer): Promise<{ id: string; name: string }> {
  const res = await fetch(`${api}/voices?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "content-type": "audio/wav" },
    body: wav,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error?.message ?? `The server answered HTTP ${res.status}.`);
  return body;
}

export class MicRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private timer = 0;

  get recording(): boolean {
    return this.recorder?.state === "recording";
  }

  async start(onLimit: () => void): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      throw new Error("This browser cannot record from a microphone here (it needs a secure page).");
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = [];
    const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    recorder.start();
    this.recorder = recorder;
    this.timer = window.setTimeout(onLimit, MAX_SAMPLE_SECONDS * 1000);
  }

  /** Ends the recording and returns what was captured. */
  stop(): Promise<ArrayBuffer> {
    const recorder = this.recorder;
    clearTimeout(this.timer);
    if (!recorder) return Promise.reject(new Error("Not recording."));
    this.recorder = null;
    return new Promise((resolve, reject) => {
      recorder.onstop = () => {
        for (const t of recorder.stream.getTracks()) t.stop();
        new Blob(this.chunks, { type: recorder.mimeType }).arrayBuffer().then(resolve, reject);
      };
      recorder.stop();
    });
  }
}

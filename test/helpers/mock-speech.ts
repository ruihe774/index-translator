// Stands in for the audio.cpp speech engine: answers every utterance with silence. Module state, like
// mock-llama.ts's `mock`: restore it with resetMockSpeech().

import { readAnonymousFile } from "../../src/anonymous-file";
import type { TranscriptSegment } from "../../src/api";
import {
  SeparationError,
  SpeechError,
  type SpeechLauncher,
  type SpeechRequest,
  type SpeechState,
  type TranscribeRequest,
  validateRecording,
  validateSample,
  type Voice,
} from "../../src/speech";
import { delay } from "./harness";

/** A tenth of a second of silence: 22.05 kHz, mono, 16-bit PCM, as the speech engine answers. */
export function silentWav(seconds = 0.1, rate = 22_050): ArrayBuffer {
  const samples = Math.round(rate * seconds);
  const view = new DataView(new ArrayBuffer(44 + samples * 2));
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) {
      view.setUint8(at + i, s.charCodeAt(i));
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples * 2, true);
  return view.buffer;
}

const builtInVoices = (): Voice[] => [
  { id: "voice_01", name: "Voice 01" },
  { id: "voice_02", name: "Voice 02" },
];

export const mockSpeech = {
  /** What `state` reports; "unavailable" makes requests fail as when nothing is installed. */
  state: "stopped" as SpeechState,
  voices: builtInVoices(),
  delayMs: 0,
  /** Length of the silence each utterance answers with. */
  audioSeconds: 0.1,
  failWith: undefined as string | undefined,
  /** Makes an upload fail as when the engine cannot separate the voice from the recording. */
  separationFailWith: undefined as string | undefined,
  /** The upload slots are all taken, as the real engine reports it. */
  voicesFull: false,
  /** Every utterance asked for. */
  requests: [] as SpeechRequest[],
  aborted: 0,
  /** An engine that does not stop: an utterance that started runs to its end, and `done` waits for it. */
  ignoreAbort: false,
  /** Utterances the engine is working on right now, whoever still waits for them. */
  running: 0,
  /** Why transcription is unavailable, if it is. */
  transcribeProblem: undefined as string | undefined,
  /** The separation model is installed. */
  canSeparate: true,
  /** What each transcription answers, one segment every `segmentDelayMs`. */
  segments: [] as TranscriptSegment[],
  segmentDelayMs: 0,
  /** Makes a transcription fail after its segments. */
  transcribeFailWith: undefined as string | undefined,
  truncated: false,
  /** Every transcription asked for. */
  transcriptions: [] as TranscribeRequest[],
};

export function resetMockSpeech(): void {
  mockSpeech.state = "stopped";
  // A test may have replaced the list (e2e control port), so restore the two built-in voices.
  mockSpeech.voices = builtInVoices();
  mockSpeech.delayMs = 0;
  mockSpeech.audioSeconds = 0.1;
  mockSpeech.failWith = undefined;
  mockSpeech.separationFailWith = undefined;
  mockSpeech.voicesFull = false;
  mockSpeech.requests.length = 0;
  mockSpeech.aborted = 0;
  mockSpeech.ignoreAbort = false;
  mockSpeech.running = 0;
  mockSpeech.transcribeProblem = undefined;
  mockSpeech.canSeparate = true;
  mockSpeech.segments = [];
  mockSpeech.segmentDelayMs = 0;
  mockSpeech.transcribeFailWith = undefined;
  mockSpeech.truncated = false;
  mockSpeech.transcriptions.length = 0;
}

export const speechLauncher: SpeechLauncher = () => ({
  get state() {
    return mockSpeech.state;
  },
  get error() {
    return mockSpeech.state === "unavailable" ? "the speech engine is not installed" : undefined;
  },
  voices: () => Promise.resolve(mockSpeech.voices),
  // eslint-disable-next-line @typescript-eslint/require-await -- a bad sample rejects, as the real engine does, rather than throwing
  async addVoice(name, wav) {
    validateSample(wav);
    if (mockSpeech.voicesFull) {
      throw new SpeechError("too many uploaded voices");
    }
    if (mockSpeech.separationFailWith) {
      throw new SeparationError(mockSpeech.separationFailWith);
    }
    const voice = { id: `upload-${mockSpeech.voices.length}`, name };
    mockSpeech.voices.push(voice);
    return voice;
  },
  async synthesize(req, signal, done) {
    if (signal.aborted) {
      done();
      mockSpeech.aborted++;
      signal.throwIfAborted();
    }
    mockSpeech.requests.push(req);
    mockSpeech.running++;
    const work = (async () => {
      try {
        if (mockSpeech.delayMs) {
          await (mockSpeech.ignoreAbort ? Bun.sleep(mockSpeech.delayMs) : delay(mockSpeech.delayMs, signal));
        }
        if (signal.aborted && !mockSpeech.ignoreAbort) {
          mockSpeech.aborted++;
          signal.throwIfAborted();
        }
        if (mockSpeech.failWith) {
          throw new SpeechError(mockSpeech.failWith);
        }
        mockSpeech.state = "ready";
        return silentWav(mockSpeech.audioSeconds);
      } finally {
        mockSpeech.running--;
        done();
      }
    })();
    if (!mockSpeech.ignoreAbort) {
      return work;
    }
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
      work.then(resolve, reject);
    });
  },
  transcribeProblem: () => mockSpeech.transcribeProblem,
  canSeparate: () => mockSpeech.canSeparate,
  // Like the worker: the stages, then the segments, stopping between two when `abort` is set.
  async transcribe(req, abort, onProgress) {
    mockSpeech.transcriptions.push(req);
    // The file is there while it runs, as the worker reads it.
    const duration = validateRecording(readAnonymousFile(req.fd));
    const flag = new Int32Array(abort);
    // As if the recording had music: `auto` separates when the model is installed.
    const separated = req.separate !== "off" && mockSpeech.canSeparate;
    if (separated) {
      onProgress({ type: "stage", stage: "separating" });
    }
    onProgress({ type: "stage", stage: "transcribing" });
    for (const segment of mockSpeech.segments) {
      await Bun.sleep(mockSpeech.segmentDelayMs);
      if (Atomics.load(flag, 0) !== 0) {
        return;
      }
      onProgress({ type: "segment", segment });
    }
    if (mockSpeech.transcribeFailWith) {
      throw new SpeechError(mockSpeech.transcribeFailWith);
    }
    return {
      type: "transcribed",
      duration,
      separated,
      trimmed: false,
      truncated: mockSpeech.truncated,
    };
  },
  async stop() {},
});

// Worker thread that owns libaudiocpp. FFI calls block, so they run here and the server thread
// stays free to answer requests. Every message is handled to its end before the next one: loads,
// unloads and utterances run in arrival order. While this thread is inside the library it reads no
// messages, so an utterance is stopped through memory it shares with the server thread instead.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { readAnonymousFile } from "./anonymous-file";
import {
  AbortedError,
  MusicDetector,
  SILERO_WEIGHTS,
  SpeechModel,
  type SpeechModelOptions,
  Transcriber,
  type TranscriptEnd,
  VoiceActivity,
  VoiceSeparator,
} from "./audiocpp-ffi";
import { soxrDir } from "./ffi-util";
import { readRecording } from "./opus-file";
import { soxrResampler } from "./resample";
import {
  cutAudio,
  cutPlan,
  hasMusic,
  LoopGuard,
  maxTokens,
  musicWindows,
  type Segment,
  SegmentReader,
  toOriginal,
  TRANSCRIBE_RATE,
} from "./transcript";
import { normalizeLoudness, type Pcm, readWav, writeWav } from "./wav";
import { abortFlag, isAborted, type NoBody, serve } from "./worker-rpc";

interface Ok {
  type: "ok";
}
interface Audio {
  type: "audio";
  wav: ArrayBuffer;
}
/** The utterance was given up because its `abort` was set. */
interface Aborted {
  type: "aborted";
}

/** What a transcription is doing now; `separating` only when it separates. */
export interface TranscribeStage {
  type: "stage";
  stage: "separating" | "transcribing";
}
export interface TranscribeSegment {
  type: "segment";
  segment: Segment;
}
export interface Transcribed {
  type: "transcribed";
  /** Seconds of the uploaded recording. */
  duration: number;
  separated: boolean;
  /** The silence was cut out before MOSS heard it (`TRIM_SILENCE_SHARE`). */
  trimmed: boolean;
  /** MOSS was stopped before it finished: its token budget ran out, or it only repeated itself. */
  truncated: boolean;
}

/** The models of one transcription; all three directories and files were found by the server thread. */
export interface TranscribeModels {
  /** MOSS-Transcribe-Diarize, on `backend`. */
  transcriber: SpeechModelOptions;
  /** The separation model, when the recording may be separated first. */
  separator?: SpeechModelOptions;
  /**
   * CED, run on the CPU: with it the recording is separated only when it has music (`hasMusic`);
   * without it, whenever there is a `separator`.
   */
  musicDetector?: SpeechModelOptions;
}

export interface SpeechProtocol {
  load: { request: { options: SpeechModelOptions }; reply: Ok };
  unload: { request: NoBody; reply: Ok };
  // `abort` holds one Int32: the server thread makes it non-zero when nobody wants the utterance
  // any more, and the library gives up at its next step (or the utterance is not started at all).
  synthesize: {
    // `voice`: a recording of VOICES_DIR, or an upload in an anonymous file.
    request: {
      text: string;
      lang: string;
      voice: { path: string } | { fd: number };
      speed: number;
      abort: SharedArrayBuffer;
    };
    reply: Audio | Aborted;
  };
  // Frees the speech model, loads the separation model, takes the vocals out of the WAV recording,
  // and frees the separation model again. The speech model is not loaded afterwards.
  separate: { request: { options: SpeechModelOptions; wav: ArrayBuffer }; reply: Audio };
  // Frees the speech model and transcribes a WAV recording, posting each segment as soon as MOSS has
  // written it: separation (when asked), loudness, Silero VAD on the CPU (which cuts out long
  // silence), MOSS. Every model is freed again afterwards. `abort` stops it between two segments.
  transcribe: {
    request: { models: TranscribeModels; fd: number; abort: SharedArrayBuffer };
    stream: TranscribeStage | TranscribeSegment;
    reply: Transcribed | Aborted;
  };
}

/** Sampling is seeded so the same sentence sounds the same when it is played again. */
const SEED = 42;

let model: SpeechModel | undefined;

/** One channel: the mean of all of them. */
function mono(pcm: Pcm): Float32Array {
  const { samples, channels } = pcm;
  if (channels === 1) {
    return samples;
  }
  const out = new Float32Array(samples.length / channels);
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      sum += samples[i * channels + c]!;
    }
    out[i] = sum / channels;
  }
  return out;
}

/** Whether CED hears music in enough of a 16 kHz mono recording (`hasMusic`); on the CPU, about 1.5 s at most. */
function music(samples: Float32Array, options: SpeechModelOptions): boolean {
  const detector = MusicDetector.load(options);
  try {
    const scores = musicWindows(samples.length, TRANSCRIBE_RATE).map(([from, to]) =>
      detector.music({ samples: samples.subarray(from, to), sampleRate: TRANSCRIBE_RATE, channels: 1 }),
    );
    return hasMusic(scores);
  } finally {
    detector.free();
  }
}

/** The sample rate the separation model takes. */
const SEPARATION_RATE = 44_100;

function unload(): void {
  model?.free();
  model = undefined;
}

serve<SpeechProtocol>({
  load: ({ options }) => {
    unload();
    model = SpeechModel.load(options);
    return { type: "ok" };
  },
  unload: () => {
    unload();
    return { type: "ok" };
  },
  synthesize: (msg) => {
    if (!model) {
      throw new Error("the speech model is not loaded");
    }
    const abort = abortFlag(msg.abort);
    // Given up while it waited behind another message.
    if (isAborted(abort)) {
      return { type: "aborted" };
    }
    const voice = readWav("fd" in msg.voice ? readAnonymousFile(msg.voice.fd) : readFileSync(msg.voice.path));
    try {
      // The model's duration control: 2 doubles the duration, so it is the inverse of the speed.
      const pcm = model.synthesize(
        msg.text,
        msg.lang,
        voice,
        { duration_factor: String(1 / msg.speed), seed: String(SEED) },
        abort,
      );
      return { type: "audio", wav: writeWav(pcm) };
    } catch (e) {
      if (e instanceof AbortedError) {
        return { type: "aborted" };
      }
      throw e;
    }
  },
  separate: (msg) => {
    // Only one of the two models is on the GPU at a time.
    unload();
    // The separation model takes 44.1 kHz, mono or stereo, and nothing else: `validateSample` has
    // checked both, so the upload goes in as it is.
    const mixture = readWav(new Uint8Array(msg.wav));
    const separator = VoiceSeparator.load(msg.options);
    try {
      return { type: "audio", wav: writeWav(normalizeLoudness(separator.vocals(mixture))) };
    } finally {
      separator.free();
    }
  },
  transcribe: ({ models, fd, abort: shared }, post) => {
    unload();
    const abort = abortFlag(shared);
    if (isAborted(abort)) {
      return { type: "aborted" };
    }
    const { dir, threads } = models.transcriber;
    const resample = soxrResampler(soxrDir(dir));
    const pcm = readRecording(readAnonymousFile(fd), dir);
    const duration = pcm.samples.length / pcm.channels / pcm.sampleRate;
    const at16k = (p: Pcm) => resample(mono(p), 1, p.sampleRate, TRANSCRIBE_RATE);
    let heard = at16k(pcm);

    const separate = models.separator !== undefined && (!models.musicDetector || music(heard, models.musicDetector));
    if (separate) {
      post({ type: "stage", stage: "separating" });
      const mixture = { ...pcm, samples: resample(pcm.samples, pcm.channels, pcm.sampleRate, SEPARATION_RATE) };
      const separator = VoiceSeparator.load(models.separator!);
      try {
        heard = at16k(separator.vocals({ ...mixture, sampleRate: SEPARATION_RATE }));
      } finally {
        separator.free();
      }
      // A separation cannot be stopped inside; an abort during it is seen here.
      if (isAborted(abort)) {
        return { type: "aborted" };
      }
    }
    post({ type: "stage", stage: "transcribing" });
    const speech = normalizeLoudness({ samples: heard, sampleRate: TRANSCRIBE_RATE, channels: 1 }, true);

    // Silero is small enough for the CPU (8 s for 30 minutes), where it was 4 times as fast as on Vulkan.
    const vad = VoiceActivity.load({
      dir,
      modelPath: join(dir, SILERO_WEIGHTS),
      family: "silero_vad",
      backend: "cpu",
      threads,
    });
    let spans: [number, number][];
    try {
      spans = vad.speech(speech);
    } finally {
      vad.free();
    }
    const plan = cutPlan(spans, speech.samples.length, TRANSCRIBE_RATE);
    const said = plan ? cutAudio(speech.samples, plan) : speech.samples;
    const saidSeconds = said.length / TRANSCRIBE_RATE;
    const original = (t: number) => (plan ? toOriginal(t, plan, TRANSCRIBE_RATE) : t);

    const transcriber = Transcriber.load(models.transcriber);
    const reader = new SegmentReader();
    const guard = new LoopGuard(saidSeconds);
    let looped = false;
    /** Posts `segments`; false once MOSS is caught in a loop, and from then on nothing more is posted. */
    const send = (segments: Segment[]): boolean => {
      for (const s of segments) {
        if (looped || guard.looping(s)) {
          looped = true;
          return false;
        }
        const start = Math.min(original(s.start), duration);
        const end = Math.min(Math.max(original(s.end), start), duration);
        post({ type: "segment", segment: { ...s, start, end } });
      }
      return true;
    };
    let end: TranscriptEnd;
    try {
      end = transcriber.transcribe(
        { samples: said, sampleRate: TRANSCRIBE_RATE, channels: 1 },
        { max_tokens: String(maxTokens(saidSeconds)) },
        (piece) => send(reader.push(piece)),
        abort,
      );
    } catch (e) {
      if (e instanceof AbortedError) {
        return { type: "aborted" };
      }
      throw e;
    } finally {
      transcriber.free();
    }
    // The last segment is complete once MOSS has stopped, unless it was stopped for a loop.
    if (end !== "stopped") {
      send(reader.end());
    }
    return {
      type: "transcribed",
      duration,
      separated: separate,
      trimmed: !!plan,
      truncated: end !== "finished" || looped,
    };
  },
});

// Reading aloud with IndexTTS-2.5, in-process through audio.cpp's C API (libaudiocpp, bun:ffi).
// The library runs on a worker thread (src/speech-worker.ts); this file is the server-thread side.
// The model is loaded by the first speech request and freed again after `SPEECH_IDLE_UNLOAD`
// seconds without one, so the translation model has the GPU to itself until somebody listens.
//
// IndexTTS has no built-in voices: every request names a reference recording from `VOICES_DIR`,
// whose voice the model imitates. A recording that is uploaded first goes through BS-RoFormer
// (when its model is installed), which takes the voice out of music and background noise; the
// speech model is unloaded while that runs, so the two never share the GPU.
//
// The same thread transcribes recordings (a preview): MOSS-Transcribe-Diarize, after the separation
// model when asked and Silero VAD. That too frees the speech model and has the GPU to itself.

import { existsSync } from "node:fs";
import { basename, join } from "node:path";

import { type AnonymousFile, anonymousFile } from "./anonymous-file";
import type { SpeechLanguage, SpeechStatus, Voice } from "./api";
import { libraryPath } from "./audiocpp-ffi";
import type { Config } from "./config";
import { fetchAdvice } from "./preflight";
import type { SpeechProtocol, Transcribed, TranscribeSegment, TranscribeStage } from "./speech-worker";
import { MUSIC_MODEL_FILE } from "./transcript";
import { type Pcm, readWav, readWavInfo, type WavInfo } from "./wav";
import { abortable, LazyModel, messageOf, startWorker, WorkerClient } from "./worker-rpc";

/** The languages IndexTTS-2.5 speaks. Any other text comes out as noise, so it is refused. */
const SPEECH_LANGUAGE_SET: Record<SpeechLanguage, true> = { zh: true, en: true, ja: true, es: true, ar: true };
/** Keyed by the API's languages: one the spec adds or drops is a type error here. */
export const SPEECH_LANGUAGES = Object.keys(SPEECH_LANGUAGE_SET) as SpeechLanguage[];

export function isSpeechLanguage(lang: string): lang is SpeechLanguage {
  return Object.hasOwn(SPEECH_LANGUAGE_SET, lang);
}
/** Longest text of one request, in code points. Clients send a document sentence by sentence. */
export const MAX_SPEECH_CHARS = 1000;
/** Range of the model's duration control: speed 2 halves the duration, 0.5 doubles it. */
export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2;

/** audio.cpp's name for the IndexTTS-2 family of models. */
const FAMILY = "index_tts2";
/** audio.cpp's name for the BS-RoFormer family, which separates the vocals of a recording from the rest. */
const SEPARATION_FAMILY = "bs_roformer";
/** audio.cpp's name for MOSS-Transcribe-Diarize, which transcribes with speakers and times. */
const TRANSCRIBE_FAMILY = "moss_transcribe_diarize";
/** CPU threads for the parts of the model that do not run on the GPU. */
const THREADS = 4;

/** Largest uploaded voice sample, and how many uploads are kept until the server stops. */
export const MAX_SAMPLE_BYTES = 8 * 1024 * 1024;
export const MAX_UPLOADED_VOICES = 16;
/** Longest name `POST /voices` keeps; a longer one is cut off. */
export const MAX_VOICE_NAME_CHARS = 60;

/**
 * Recording limits of an uploaded sample: a few seconds suffice, and audio.cpp's IndexTTS-2 keeps
 * only the first 15 s of a reference, so more would only slow the separation.
 */
export const MIN_SAMPLE_SECONDS = 1;
export const MAX_SAMPLE_SECONDS = 15;
/** The one rate BS-RoFormer accepts; the client resamples, so the server never does. */
export const SAMPLE_RATE = 44_100;
/** BS-RoFormer takes mono or stereo; a mono sample is duplicated by audio.cpp. */
const MAX_SAMPLE_CHANNELS = 2;

/** Longest recording `POST /transcriptions` takes: VRAM beside the translation model was measured up to here. */
export const MAX_TRANSCRIBE_SECONDS = 30 * 60;
/** Its largest body: 30 minutes of 16-bit mono at 44.1 kHz. */
export const MAX_TRANSCRIBE_BYTES = 160 * 1024 * 1024;
/** Sample rates it takes; the server resamples. */
export const MIN_TRANSCRIBE_RATE = 16_000;
export const MAX_TRANSCRIBE_RATE = 48_000;

export class SpeechError extends Error {}

/** Separating the voice from an uploaded sample failed in the engine; the sample itself may be fine. */
export class SeparationError extends SpeechError {}

export type { Voice };

export interface SpeechRequest {
  text: string;
  lang: SpeechLanguage;
  /** A voice id from `voices()`. */
  voice: string;
  speed: number;
}

/**
 * `unavailable`: turned off, or the engine or the model is missing (`error` says which);
 * `stopped`: installed, the model is not loaded; `starting`: loading it; `ready`; `error`: the
 * last load failed.
 */
export type SpeechState = SpeechStatus;

export interface Speech {
  readonly state: SpeechState;
  readonly error: string | undefined;
  voices(): Promise<Voice[]>;
  /**
   * Keeps a WAV recording as a voice until the server stops, with its voice separated from music and
   * noise when the separation model is installed. Rejects with SpeechError if it is not a usable WAV,
   * and with SeparationError if the separation failed.
   */
  addVoice(name: string, wav: ArrayBuffer): Promise<Voice>;
  /**
   * One utterance as a WAV file. Rejects with SpeechError, or the signal's reason when aborted,
   * which happens at once; the engine is told to stop and does so within its current step.
   * `done` is called exactly once, when the engine no longer works on the utterance: it finished,
   * failed, stopped, or was never started because the signal aborted first. The caller keeps its
   * queue slot until then, so the next utterance is never started beside one still being stopped.
   */
  synthesize(req: SpeechRequest, signal: AbortSignal, done: () => void): Promise<ArrayBuffer>;
  /** Why transcription cannot run, or undefined when it can be tried. */
  transcribeProblem(): string | undefined;
  /** Whether the separation model is installed for transcription (`separate: "on"` needs it). */
  canSeparate(): boolean;
  /**
   * Transcribes a recording `validateRecording` accepted, calling `onProgress` with each stage and
   * segment. Resolves with the summary, or with undefined when `abort` (one Int32, made non-zero by
   * the caller) stopped it; rejects with SpeechError. The caller holds the speech line meanwhile.
   */
  transcribe(
    req: TranscribeRequest,
    abort: SharedArrayBuffer,
    onProgress: (p: TranscribeProgress) => void,
  ): Promise<Transcribed | undefined>;
  stop(): Promise<void>;
}

export type SpeechLauncher = (cfg: Config) => Speech;

/** Decodes an uploaded sample and checks its sample rate and duration. Throws SpeechError. */
export function validateSample(wav: ArrayBuffer): Pcm {
  let pcm: Pcm;
  try {
    pcm = readWav(new Uint8Array(wav));
  } catch (e) {
    throw new SpeechError(`the sample cannot be used: ${messageOf(e)}`);
  }
  if (pcm.sampleRate !== SAMPLE_RATE) {
    throw new SpeechError(`the sample rate of ${pcm.sampleRate} Hz is not supported (it must be ${SAMPLE_RATE} Hz)`);
  }
  if (pcm.channels > MAX_SAMPLE_CHANNELS) {
    throw new SpeechError(`the sample has ${pcm.channels} channels (at most ${MAX_SAMPLE_CHANNELS})`);
  }
  const seconds = pcm.samples.length / pcm.channels / pcm.sampleRate;
  if (seconds < MIN_SAMPLE_SECONDS) {
    throw new SpeechError(`the sample is too short (${seconds.toFixed(2)} s; at least ${MIN_SAMPLE_SECONDS} s)`);
  }
  if (seconds > MAX_SAMPLE_SECONDS) {
    throw new SpeechError(`the sample is too long (${seconds.toFixed(1)} s; at most ${MAX_SAMPLE_SECONDS} s)`);
  }
  return pcm;
}

/**
 * Checks the format and duration of an uploaded recording to transcribe from its header (the audio is
 * decoded only by the worker) and answers its duration in seconds. Throws SpeechError.
 */
export function validateRecording(wav: Uint8Array): number {
  let info: WavInfo;
  try {
    info = readWavInfo(wav);
  } catch (e) {
    throw new SpeechError(`the recording cannot be used: ${messageOf(e)}`);
  }
  if (info.sampleRate < MIN_TRANSCRIBE_RATE || info.sampleRate > MAX_TRANSCRIBE_RATE) {
    throw new SpeechError(
      `the sample rate of ${info.sampleRate} Hz is not supported (${MIN_TRANSCRIBE_RATE} to ${MAX_TRANSCRIBE_RATE} Hz)`,
    );
  }
  if (info.channels > MAX_SAMPLE_CHANNELS) {
    throw new SpeechError(`the recording has ${info.channels} channels (at most ${MAX_SAMPLE_CHANNELS})`);
  }
  const seconds = info.frames / info.sampleRate;
  if (seconds > MAX_TRANSCRIBE_SECONDS) {
    throw new SpeechError(`the recording is too long (${Math.round(seconds)} s; at most ${MAX_TRANSCRIBE_SECONDS} s)`);
  }
  return seconds;
}

/**
 * `auto` separates when the separation model is installed and CED hears music in the recording (with
 * the separation model but not CED, always).
 */
export type SeparateMode = "auto" | "on" | "off";

export interface TranscribeRequest {
  /** The recording, in an anonymous file the caller closes when the transcription has ended. */
  fd: number;
  separate: SeparateMode;
}

/** What a transcription posts while it runs. */
export type TranscribeProgress = TranscribeStage | TranscribeSegment;
export type { Transcribed };

/** Starts the thread that owns libaudiocpp; replaceable in tests. */
type SpeechWorkerFactory = () => Worker;

const defaultWorker: SpeechWorkerFactory = () => startWorker("speech-worker.ts");

/** The `fetch_models.ts` id of MOSS-Transcribe-Diarize. */
export const TRANSCRIBE_MODEL_ID = "moss-transcribe-diarize";

/**
 * The `fetch_models.ts` ids of the speech, separation and transcription models that are not installed;
 * the first two only while speech is on, the last only while transcription is.
 */
export function missingSpeechModels(cfg: Config): string[] {
  const missing: string[] = [];
  if (cfg.speech && !existsSync(cfg.speechModelDir)) {
    missing.push("index-tts-2.5");
  }
  if (cfg.speech && !findSeparationModel(cfg)) {
    missing.push("bs-roformer");
  }
  if (cfg.transcribe && !findTranscribeModel(cfg)) {
    missing.push(TRANSCRIBE_MODEL_ID);
  }
  return missing;
}

/** The first BS-RoFormer GGUF in `SEPARATION_MODEL_DIR`, if there is one. */
function findSeparationModel(cfg: Config): string | undefined {
  return findGguf(cfg.separationModelDir);
}

/** The first GGUF in `dir` whose name matches `pattern`, if there is one. */
function findGguf(dir: string, pattern = "*.gguf"): string | undefined {
  const file = existsSync(dir)
    ? (new Bun.Glob(pattern).scanSync({ cwd: dir, onlyFiles: true }).next().value as string | undefined)
    : undefined;
  return file ? join(dir, file) : undefined;
}

/** MOSS-Transcribe-Diarize's GGUF in `TRANSCRIBE_MODEL_DIR`, if there is one (CED's is beside it). */
const findTranscribeModel = (cfg: Config) => findGguf(cfg.transcribeModelDir, "moss-*.gguf");

const MUSIC_FAMILY = "ced";

export class NativeSpeech implements Speech {
  /** The thread that owns libaudiocpp, started by the first request. */
  private readonly worker: WorkerClient<SpeechProtocol>;
  private readonly model: LazyModel;
  /**
   * Set while a sample is being separated or a recording transcribed, which needs the GPU to itself;
   * settles when it is over.
   */
  private exclusive: Promise<void> | null = null;

  /** Uploaded voices: id to an anonymous file (gone with the process). Ids never become paths. */
  private readonly uploads = new Map<string, { name: string; file: AnonymousFile }>();

  constructor(
    private readonly cfg: Config,
    makeWorker: SpeechWorkerFactory = defaultWorker,
  ) {
    // If the thread dies its model is gone with it; the next request starts another.
    this.worker = new WorkerClient({
      start: makeWorker,
      label: "speech thread",
      fail: (reply) => new SpeechError(reply.message),
      onLost: (reason) => {
        this.model.workerLost(reason);
        console.error(`[speech] ${reason}`);
      },
    });
    this.model = new LazyModel({
      tag: "speech",
      model: "speech model",
      missing: () => this.missing(),
      idleUnload: cfg.speechIdleUnload,
      load: async () => {
        await this.worker.call("load", {
          options: {
            dir: cfg.audioDir,
            modelPath: cfg.speechModelDir,
            family: FAMILY,
            backend: cfg.speechBackend,
            threads: THREADS,
          },
        });
        return "";
      },
      unload: () => this.worker.call("unload"),
      error: (message) => new SpeechError(message),
    });
  }

  /** Why speech cannot run at all, checked each time so an install does not need a restart. */
  private missing(): string | undefined {
    if (!this.cfg.speech) {
      return "reading aloud is turned off (SPEECH=0)";
    }
    if (!existsSync(libraryPath(this.cfg.audioDir))) {
      return "the speech engine is not installed; run bun scripts/build_audiocpp.ts";
    }
    if (!existsSync(this.cfg.speechModelDir)) {
      return `the speech model is not installed; ${fetchAdvice(["index-tts-2.5"])}`;
    }
    return undefined;
  }

  get state(): SpeechState {
    return this.model.state;
  }

  get error(): string | undefined {
    return this.model.error;
  }

  async voices(): Promise<Voice[]> {
    // A missing voices directory still leaves the uploads.
    const files = await Array.fromAsync(new Bun.Glob("*.wav").scan({ cwd: this.cfg.voicesDir, onlyFiles: true })).catch(
      () => [] as string[],
    );
    const installed = files.sort().map((f) => {
      const id = basename(f, ".wav");
      return { id, name: id.replaceAll(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase()) };
    });
    return [...installed, ...[...this.uploads].map(([id, u]) => ({ id, name: u.name }))];
  }

  async addVoice(name: string, wav: ArrayBuffer): Promise<Voice> {
    // Decoded once here, so a recording the engine could not read is refused when it is uploaded.
    validateSample(wav);
    const tooMany = () => new SpeechError("too many uploaded voices");
    if (this.uploads.size >= MAX_UPLOADED_VOICES) {
      throw tooMany();
    }
    const voice = this.separationInstalled() ? await this.separate(wav) : wav;
    // Uploads that finished while this one was being separated may have filled the slots.
    if (this.uploads.size >= MAX_UPLOADED_VOICES) {
      throw tooMany();
    }
    const id = `upload-${crypto.randomUUID()}`;
    this.uploads.set(id, { name, file: await anonymousFile(new Uint8Array(voice)) });
    return { id, name };
  }

  /** The BS-RoFormer GGUF in `SEPARATION_MODEL_DIR`, if the speech engine and the model are installed. */
  private separationModel(): string | undefined {
    if (this.missing()) {
      return undefined;
    }
    return findSeparationModel(this.cfg);
  }

  private separationInstalled(): boolean {
    return this.separationModel() !== undefined;
  }

  canSeparate(): boolean {
    return findSeparationModel(this.cfg) !== undefined;
  }

  /**
   * Runs `fn` with the GPU to itself: the speech model is freed for it (by the worker) and loaded again
   * by the next utterance. One such job runs at a time, and utterances not yet sent to the worker wait
   * until it is over.
   */
  private async alone<T>(fn: () => Promise<T>): Promise<T> {
    while (this.exclusive) {
      await this.exclusive;
    }
    let finished!: () => void;
    this.exclusive = new Promise<void>((resolve) => void (finished = resolve));
    try {
      // A load in progress ends first, or it would report a model that is gone.
      await this.model.settled();
      this.model.unloaded();
      return await fn();
    } finally {
      this.exclusive = null;
      finished();
    }
  }

  /** The voice of a WAV recording without music and noise, as a WAV file. */
  private separate(wav: ArrayBuffer): Promise<ArrayBuffer> {
    return this.alone(async () => {
      const modelPath = this.separationModel();
      if (!modelPath) {
        throw new SeparationError("the separation model is gone");
      }
      const started = performance.now();
      const reply = await this.worker
        .call("separate", {
          options: {
            dir: this.cfg.audioDir,
            modelPath,
            family: SEPARATION_FAMILY,
            backend: this.cfg.speechBackend,
            threads: THREADS,
          },
          wav,
        })
        .catch((e) => {
          throw new SeparationError(`separating the voice failed: ${messageOf(e)}`);
        });
      console.error(`[speech] voice separated (${Math.round(performance.now() - started)} ms)`);
      return reply.wav;
    });
  }

  transcribeProblem(): string | undefined {
    if (!this.cfg.transcribe) {
      return "transcription is turned off (TRANSCRIBE=0)";
    }
    // Reading aloud may be off or its model missing: transcription needs only the engine and its own model.
    if (!existsSync(libraryPath(this.cfg.audioDir))) {
      return "the speech engine is not installed; run bun scripts/build_audiocpp.ts";
    }
    if (!findTranscribeModel(this.cfg)) {
      return `the transcription model is not installed; ${fetchAdvice([TRANSCRIBE_MODEL_ID])}`;
    }
    return undefined;
  }

  transcribe(
    req: TranscribeRequest,
    abort: SharedArrayBuffer,
    onProgress: (p: TranscribeProgress) => void,
  ): Promise<Transcribed | undefined> {
    return this.alone(async () => {
      const problem = this.transcribeProblem();
      const modelPath = findTranscribeModel(this.cfg);
      if (problem || !modelPath) {
        throw new SpeechError(problem ?? "the transcription model is gone");
      }
      const options = (path: string, family: string) => ({
        dir: this.cfg.audioDir,
        modelPath: path,
        family,
        backend: this.cfg.speechBackend,
        threads: THREADS,
      });
      const separation = req.separate === "off" ? undefined : findSeparationModel(this.cfg);
      const musicModel = join(this.cfg.transcribeModelDir, MUSIC_MODEL_FILE);
      if (req.separate === "on" && !separation) {
        throw new SeparationError("the separation model is gone");
      }
      const started = performance.now();
      const reply = await new Promise<Transcribed | undefined>((resolve, reject) => {
        const { close } = this.worker.stream(
          "transcribe",
          {
            models: {
              transcriber: options(modelPath, TRANSCRIBE_FAMILY),
              separator: separation ? options(separation, SEPARATION_FAMILY) : undefined,
              // Without CED, `auto` separates whenever the separation model is installed.
              musicDetector:
                req.separate === "auto" && existsSync(musicModel)
                  ? { ...options(musicModel, MUSIC_FAMILY), backend: "cpu" }
                  : undefined,
            },
            fd: req.fd,
            abort,
          },
          (r) => {
            if (r.type === "stage" || r.type === "segment") {
              onProgress(r);
              return;
            }
            close();
            if (r.type === "error") {
              reject(new SpeechError(`the transcription failed: ${r.message}`));
            } else {
              resolve(r.type === "aborted" ? undefined : r);
            }
          },
        );
      });
      const ms = Math.round(performance.now() - started);
      console.error(
        `[speech] ${reply ? `recording of ${Math.round(reply.duration)} s transcribed` : "transcription stopped"} (${ms} ms)`,
      );
      return reply;
    });
  }

  /**
   * One utterance, once the model is loaded and no separation is under way. `started` is called when
   * it is handed to the worker. From then on only `abort` (the flag the worker and the library read)
   * stops it, and the worker's reply says when it has.
   */
  private async run(
    req: SpeechRequest,
    signal: AbortSignal,
    abort: SharedArrayBuffer,
    started: () => void,
  ): Promise<ArrayBuffer> {
    // The model is checked again after every wait: a separation or transcription that starts in between frees it.
    do {
      while (this.exclusive) {
        await this.exclusive;
      }
      await this.model.ready();
    } while (this.exclusive || !this.model.loaded);
    // Gone while the model was loading: the utterance is never sent.
    signal.throwIfAborted();
    started();
    const reply = await this.worker.call("synthesize", {
      text: req.text,
      lang: req.lang,
      voice: (() => {
        const upload = this.uploads.get(req.voice);
        return upload ? { fd: upload.file.fd } : { path: join(this.cfg.voicesDir, `${req.voice}.wav`) };
      })(),
      speed: req.speed,
      abort,
    });
    // Nobody receives this: the caller was answered with the signal's reason when it aborted.
    if (reply.type === "aborted") {
      throw new SpeechError("the utterance was stopped");
    }
    return reply.wav;
  }

  synthesize(req: SpeechRequest, signal: AbortSignal, done: () => void): Promise<ArrayBuffer> {
    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      done();
    };
    const missing = this.missing();
    if (missing) {
      release();
      return Promise.reject(new SpeechError(missing));
    }
    // An aborted request is answered at once. A posted utterance is stopped through the flag, at
    // the library's next step, and `done` waits for the worker to say so. An utterance not posted
    // yet is never sent, and its `done` need not wait for the model to load.
    return abortable(
      signal,
      async (abort, started) => {
        const unhold = this.model.hold();
        try {
          return await this.run(req, signal, abort, started);
        } finally {
          unhold();
          release();
        }
      },
      release,
    );
  }

  async stop(): Promise<void> {
    if (this.worker.started) {
      // Waits for a running utterance, then frees the model.
      await this.worker.call("unload").catch(() => {});
      this.worker.terminate();
    }
    this.model.unloaded();
    await Promise.all([...this.uploads.values()].map((u) => u.file.close()));
    this.uploads.clear();
  }
}

export const nativeSpeech: SpeechLauncher = (cfg) => new NativeSpeech(cfg);

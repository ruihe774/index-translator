// Reading aloud with IndexTTS-2.5, in-process through audio.cpp's C API (libaudiocpp, bun:ffi).
// The library runs on a worker thread (src/speech-worker.ts); this file is the server-thread side.
// The model is loaded by the first speech request and freed again after `SPEECH_IDLE_UNLOAD`
// seconds without one, so the translation model has the GPU to itself until somebody listens.
//
// IndexTTS has no built-in voices: every request names a reference recording from `VOICES_DIR`,
// whose voice the model imitates. A recording that is uploaded first goes through BS-RoFormer
// (when its model is installed), which takes the voice out of music and background noise; the
// speech model is unloaded while that runs, so the two never share the GPU.

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { SpeechLanguage, SpeechStatus, Voice } from "./api";
import { libraryPath } from "./audiocpp-ffi";
import type { Config } from "./config";
import { fetchAdvice } from "./preflight";
import type { SpeechProtocol } from "./speech-worker";
import { type Pcm, readWav } from "./wav";
import { abortable, LazyModel, messageOf, WorkerClient } from "./worker-rpc";

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

/** Starts the thread that owns libaudiocpp; replaceable in tests. */
type SpeechWorkerFactory = () => Worker;

const defaultWorker: SpeechWorkerFactory = () =>
  // Not referenced: the server decides when the process ends, not an idle speech thread.
  new Worker(new URL("speech-worker.ts", import.meta.url).href, { ref: false });

/** The `fetch_models.ts` ids of the speech and separation models that are not installed; none while speech is off. */
export function missingSpeechModels(cfg: Config): string[] {
  if (!cfg.speech) {
    return [];
  }
  const missing: string[] = [];
  if (!existsSync(cfg.speechModelDir)) {
    missing.push("index-tts-2.5");
  }
  const dir = cfg.separationModelDir;
  if (!existsSync(dir) || new Bun.Glob("*.gguf").scanSync({ cwd: dir, onlyFiles: true }).next().done) {
    missing.push("bs-roformer");
  }
  return missing;
}

export class NativeSpeech implements Speech {
  /** The thread that owns libaudiocpp, started by the first request. */
  private readonly worker: WorkerClient<SpeechProtocol>;
  private readonly model: LazyModel;
  /** Set while a sample is being separated, which needs the GPU to itself; settles when it is over. */
  private separating: Promise<void> | null = null;

  /** Uploaded voices: id to file. Ids never become paths. */
  private readonly uploads = new Map<string, { name: string; path: string }>();
  private readonly uploadDir = join(tmpdir(), `index-translator-voices-${process.pid}`);

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
    const path = join(this.uploadDir, `${id}.wav`);
    // Bun.write creates the upload directory too.
    await Bun.write(path, voice);
    this.uploads.set(id, { name, path });
    return { id, name };
  }

  /** The BS-RoFormer GGUF in `SEPARATION_MODEL_DIR`, if the speech engine and the model are installed. */
  private separationModel(): string | undefined {
    if (this.missing()) {
      return undefined;
    }
    const dir = this.cfg.separationModelDir;
    const file = existsSync(dir)
      ? (new Bun.Glob("*.gguf").scanSync({ cwd: dir, onlyFiles: true }).next().value as string | undefined)
      : undefined;
    return file ? join(dir, file) : undefined;
  }

  private separationInstalled(): boolean {
    return this.separationModel() !== undefined;
  }

  /**
   * The voice of a WAV recording without music and noise, as a WAV file. The speech model is freed
   * for it and loaded again by the next utterance. Separations run one at a time, and utterances
   * not yet sent to the worker wait until it is over.
   */
  private async separate(wav: ArrayBuffer): Promise<ArrayBuffer> {
    while (this.separating) {
      await this.separating;
    }
    let finished!: () => void;
    this.separating = new Promise<void>((resolve) => void (finished = resolve));
    try {
      // A load in progress ends first, or it would report a model that is gone.
      await this.model.settled();
      const modelPath = this.separationModel();
      if (!modelPath) {
        throw new SeparationError("the separation model is gone");
      }
      this.model.unloaded();
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
    } finally {
      this.separating = null;
      finished();
    }
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
    // The model is checked again after every wait: a separation that starts in between frees it.
    do {
      while (this.separating) {
        await this.separating;
      }
      await this.model.ready();
    } while (this.separating || !this.model.loaded);
    // Gone while the model was loading: the utterance is never sent.
    signal.throwIfAborted();
    started();
    const reply = await this.worker.call("synthesize", {
      text: req.text,
      lang: req.lang,
      voicePath: this.uploads.get(req.voice)?.path ?? join(this.cfg.voicesDir, `${req.voice}.wav`),
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
    await rm(this.uploadDir, { recursive: true, force: true });
    this.uploads.clear();
  }
}

export const nativeSpeech: SpeechLauncher = (cfg) => new NativeSpeech(cfg);

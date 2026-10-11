// Reading aloud with IndexTTS-2.5, in-process through audio.cpp's C API (libaudiocpp, bun:ffi).
// The library runs on a worker thread (src/speech-worker.ts); this file is the server-thread side.
// The model is loaded by the first speech request and freed again after `SPEECH_IDLE_UNLOAD`
// seconds without one, so the translation model has the GPU to itself until somebody listens.
//
// IndexTTS has no built-in voices: every request names a reference recording from `VOICES_DIR`,
// whose voice the model imitates.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { libraryPath } from "./audiocpp-ffi";
import type { Config } from "./config";
import type { SpeechWorkerReply, SpeechWorkerRequest } from "./speech-worker";
import { type Pcm, readWav } from "./wav";

/** The languages IndexTTS-2.5 speaks. Any other text comes out as noise, so it is refused. */
export const SPEECH_LANGUAGES = ["zh", "en", "ja", "es", "ar"];
/** Longest text of one request, in code points. Clients send a document sentence by sentence. */
export const MAX_SPEECH_CHARS = 1000;
/** Range of the model's duration control: speed 2 halves the duration, 0.5 doubles it. */
export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2;

/** audio.cpp's name for the IndexTTS-2 family of models. */
const FAMILY = "index_tts2";
/** CPU threads for the parts of the model that do not run on the GPU. */
const THREADS = 4;

/** Largest uploaded voice sample, and how many uploads are kept until the server stops. */
export const MAX_SAMPLE_BYTES = 8 * 1024 * 1024;
export const MAX_UPLOADED_VOICES = 16;

/** Recording limits of an uploaded sample: a few seconds suffice, a long one only slows every utterance. */
export const MIN_SAMPLE_SECONDS = 1;
export const MAX_SAMPLE_SECONDS = 60;
export const MIN_SAMPLE_RATE = 8000;
export const MAX_SAMPLE_RATE = 192000;

export class SpeechError extends Error {}

export interface Voice {
  id: string;
  name: string;
}

export interface SpeechRequest {
  text: string;
  lang: string;
  /** A voice id from `voices()`. */
  voice: string;
  speed: number;
}

/**
 * `unavailable`: turned off, or the engine or the model is missing (`error` says which);
 * `stopped`: installed, the model is not loaded; `starting`: loading it; `ready`; `error`: the
 * last load failed.
 */
export type SpeechState = "unavailable" | "stopped" | "starting" | "ready" | "error";

export interface Speech {
  readonly state: SpeechState;
  readonly error: string | undefined;
  voices(): Promise<Voice[]>;
  /** Keeps a WAV recording as a voice until the server stops. Rejects with SpeechError if it is not a WAV. */
  addVoice(name: string, wav: ArrayBuffer): Promise<Voice>;
  /**
   * One utterance as a WAV file. Rejects with SpeechError, or the signal's reason when aborted,
   * which happens at once even if the engine cannot stop the utterance.
   * `done` is called exactly once, when the engine no longer works on the utterance: it finished,
   * failed, or was never started because the signal aborted first. The caller keeps its queue slot
   * until then, so abandoned work still counts against the queue.
   */
  synthesize(req: SpeechRequest, signal: AbortSignal, done: () => void): Promise<ArrayBuffer>;
  stop(): Promise<void>;
}

export type SpeechLauncher = (cfg: Config) => Speech;

type Send<T> = T extends unknown ? Omit<T, "req"> : never;

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Decodes an uploaded sample and checks its sample rate and duration. Throws SpeechError. */
export function validateSample(wav: ArrayBuffer): Pcm {
  let pcm: Pcm;
  try {
    pcm = readWav(new Uint8Array(wav));
  } catch (e) {
    throw new SpeechError(`the sample cannot be used: ${messageOf(e)}`);
  }
  if (pcm.sampleRate < MIN_SAMPLE_RATE || pcm.sampleRate > MAX_SAMPLE_RATE) {
    throw new SpeechError(
      `the sample rate of ${pcm.sampleRate} Hz is not supported (${MIN_SAMPLE_RATE} to ${MAX_SAMPLE_RATE} Hz)`,
    );
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
export type SpeechWorkerFactory = () => Worker;

const defaultWorker: SpeechWorkerFactory = () =>
  // Not referenced: the server decides when the process ends, not an idle speech thread.
  new Worker(new URL("./speech-worker.ts", import.meta.url).href, { ref: false });

export class NativeSpeech implements Speech {
  /** The thread that owns libaudiocpp, started by the first request. */
  private worker: Worker | null = null;
  private waiting = new Map<number, (reply: SpeechWorkerReply) => void>();
  private lastReq = 0;

  private loaded = false;
  private loading: Promise<void> | null = null;
  private failure: string | undefined;
  /** Utterances asked for that the worker has not finished, whether or not their client still waits. */
  private pending = 0;
  private idle: Timer | undefined;

  /** Uploaded voices: id to file. Ids never become paths. */
  private uploads = new Map<string, { name: string; path: string }>();
  private readonly uploadDir = join(tmpdir(), `index-translator-voices-${process.pid}`);

  constructor(
    private cfg: Config,
    private makeWorker: SpeechWorkerFactory = defaultWorker,
  ) {}

  /** Why speech cannot run at all, checked each time so an install does not need a restart. */
  private missing(): string | undefined {
    if (!this.cfg.speech) return "reading aloud is turned off (SPEECH=0)";
    if (!existsSync(libraryPath(this.cfg.audioDir))) {
      return "the speech engine is not installed; run bun scripts/build_audiocpp.ts";
    }
    if (!existsSync(this.cfg.speechModelDir)) {
      return "the speech model is not installed; run uv run scripts/fetch_models.py --model index-tts-2.5";
    }
    return undefined;
  }

  get state(): SpeechState {
    if (this.missing()) return "unavailable";
    if (this.loaded) return "ready";
    if (this.loading) return "starting";
    return this.failure ? "error" : "stopped";
  }

  get error(): string | undefined {
    return this.missing() ?? (this.loaded || this.loading ? undefined : this.failure);
  }

  async voices(): Promise<Voice[]> {
    // A missing voices directory still leaves the uploads.
    const files = await readdir(this.cfg.voicesDir).catch(() => [] as string[]);
    const installed = files
      .filter((f) => extname(f) === ".wav")
      .sort()
      .map((f) => {
        const id = basename(f, ".wav");
        return { id, name: id.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase()) };
      });
    return [...installed, ...[...this.uploads].map(([id, u]) => ({ id, name: u.name }))];
  }

  async addVoice(name: string, wav: ArrayBuffer): Promise<Voice> {
    // Decoded once here, so a recording the engine could not read is refused when it is uploaded.
    validateSample(wav);
    if (this.uploads.size >= MAX_UPLOADED_VOICES) throw new SpeechError("too many uploaded voices");
    const id = `upload-${randomUUID()}`;
    const path = join(this.uploadDir, `${id}.wav`);
    await mkdir(this.uploadDir, { recursive: true });
    await Bun.write(path, wav);
    this.uploads.set(id, { name, path });
    return { id, name };
  }

  /** One request to the worker, one reply. */
  private call(msg: Send<SpeechWorkerRequest>): Promise<SpeechWorkerReply> {
    const worker = this.worker ?? this.startWorker();
    return new Promise((resolve, reject) => {
      const req = ++this.lastReq;
      this.waiting.set(req, (reply) => {
        this.waiting.delete(req);
        if (reply.type === "error") reject(new SpeechError(reply.message));
        else resolve(reply);
      });
      worker.postMessage({ ...msg, req });
    });
  }

  private startWorker(): Worker {
    const worker = this.makeWorker();
    worker.onmessage = (event: MessageEvent<SpeechWorkerReply>) => this.waiting.get(event.data.req)?.(event.data);
    // If the thread dies its model is gone with it; the next request starts another.
    const lost = (reason: string) => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.loaded = false;
      this.failure = reason;
      console.error(`[speech] ${reason}`);
      for (const [req, deliver] of this.waiting) deliver({ type: "error", req, message: reason });
    };
    worker.onerror = (event) => lost(`the speech thread failed: ${event.message}`);
    worker.addEventListener("close", () => lost("the speech thread exited"));
    this.worker = worker;
    return worker;
  }

  private async load(): Promise<void> {
    const started = performance.now();
    try {
      await this.call({
        type: "load",
        options: {
          dir: this.cfg.audioDir,
          modelPath: this.cfg.speechModelDir,
          family: FAMILY,
          backend: this.cfg.speechBackend,
          threads: THREADS,
        },
      });
    } catch (e) {
      this.failure = `the speech model could not be loaded: ${messageOf(e)}`;
      console.error(`[speech] ${this.failure}`);
      throw new SpeechError(this.failure);
    }
    this.loaded = true;
    this.failure = undefined;
    console.error(`[speech] model ready (${Math.round(performance.now() - started)} ms)`);
  }

  private ready(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    this.loading ??= this.load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  /** Frees the model once nothing has been asked of it for `SPEECH_IDLE_UNLOAD` seconds. */
  private unloadWhenIdle(): void {
    clearTimeout(this.idle);
    if (this.pending > 0 || !this.loaded || this.cfg.speechIdleUnload <= 0) return;
    this.idle = setTimeout(() => {
      if (this.pending > 0 || !this.loaded) return;
      // A request that arrives from here on loads the model again; the worker frees it first.
      this.loaded = false;
      this.call({ type: "unload" }).then(
        () => console.error("[speech] model unloaded after being idle"),
        () => {},
      );
    }, this.cfg.speechIdleUnload * 1000);
    this.idle.unref();
  }

  /** `posted` is set once the utterance has been handed to the worker, which cannot take it back. */
  private async run(req: SpeechRequest, signal: AbortSignal, posted: { value: boolean }): Promise<ArrayBuffer> {
    await this.ready();
    // Gone while the model was loading: the utterance is never sent.
    signal.throwIfAborted();
    posted.value = true;
    const reply = await this.call({
      type: "synthesize",
      text: req.text,
      lang: req.lang,
      voicePath: this.uploads.get(req.voice)?.path ?? join(this.cfg.voicesDir, `${req.voice}.wav`),
      speed: req.speed,
    });
    if (reply.type !== "audio") throw new SpeechError(`unexpected ${reply.type} reply to an utterance`);
    return reply.wav;
  }

  synthesize(req: SpeechRequest, signal: AbortSignal, done: () => void): Promise<ArrayBuffer> {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      done();
    };
    const missing = this.missing();
    if (missing) {
      release();
      return Promise.reject(new SpeechError(missing));
    }
    if (signal.aborted) {
      release();
      return Promise.reject(signal.reason);
    }
    clearTimeout(this.idle);
    this.pending++;
    const posted = { value: false };
    const work = this.run(req, signal, posted).finally(() => {
      this.pending--;
      this.unloadWhenIdle();
      release();
    });
    // The library cannot stop an utterance. An aborted request is answered at once; the worker
    // finishes a posted utterance and nobody receives it, so `done` waits for the worker. An
    // utterance not posted yet is never sent, and its `done` need not wait for the model to load.
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (!posted.value) release();
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  async stop(): Promise<void> {
    clearTimeout(this.idle);
    const worker = this.worker;
    if (worker) {
      // Waits for a running utterance, then frees the model.
      await this.call({ type: "unload" }).catch(() => {});
      if (this.worker === worker) this.worker = null;
      worker.terminate();
    }
    this.loaded = false;
    await rm(this.uploadDir, { recursive: true, force: true });
    this.uploads.clear();
  }
}

export const nativeSpeech: SpeechLauncher = (cfg) => new NativeSpeech(cfg);

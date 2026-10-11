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
import { readWav } from "./wav";

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
  /** One utterance as a WAV file. Rejects with SpeechError, or the signal's reason when aborted. */
  synthesize(req: SpeechRequest, signal: AbortSignal): Promise<ArrayBuffer>;
  stop(): Promise<void>;
}

export type SpeechLauncher = (cfg: Config) => Speech;

type Send<T> = T extends unknown ? Omit<T, "req"> : never;

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

class NativeSpeech implements Speech {
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

  constructor(private cfg: Config) {}

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
    let files: string[];
    try {
      files = await readdir(this.cfg.voicesDir);
    } catch {
      return [];
    }
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
    try {
      readWav(new Uint8Array(wav));
    } catch (e) {
      throw new SpeechError(`the sample cannot be used: ${messageOf(e)}`);
    }
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
    // Not referenced: the server decides when the process ends, not an idle speech thread.
    const worker = new Worker(new URL("./speech-worker.ts", import.meta.url).href, { ref: false });
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

  private async run(req: SpeechRequest, signal: AbortSignal): Promise<ArrayBuffer> {
    await this.ready();
    // Gone while the model was loading: the utterance is not started.
    signal.throwIfAborted();
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

  synthesize(req: SpeechRequest, signal: AbortSignal): Promise<ArrayBuffer> {
    const missing = this.missing();
    if (missing) return Promise.reject(new SpeechError(missing));
    if (signal.aborted) return Promise.reject(signal.reason);
    clearTimeout(this.idle);
    this.pending++;
    const work = this.run(req, signal).finally(() => {
      this.pending--;
      this.unloadWhenIdle();
    });
    // The library cannot stop an utterance. An aborted request is answered at once; the worker
    // finishes the utterance, nobody receives it, and whatever comes next waits behind it.
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
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

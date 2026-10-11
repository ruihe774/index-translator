// Reading aloud with IndexTTS-2.5. The model runs in audio.cpp's `audiocpp_server`, a child process
// on a loopback port that only this server talks to. It is started by the first speech request,
// loads the model on its first synthesis and frees it again after `SPEECH_IDLE_UNLOAD` seconds
// without one, so the translation model has the GPU to itself until somebody listens.
//
// IndexTTS has no built-in voices: every request names a reference recording from `VOICES_DIR`,
// whose voice the model imitates.

import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import type { Config } from "./config";

/** The languages IndexTTS-2.5 speaks. Any other text comes out as noise, so it is refused. */
export const SPEECH_LANGUAGES = ["zh", "en", "ja", "es", "ar"];
/** Longest text of one request, in code points. Clients send a document sentence by sentence. */
export const MAX_SPEECH_CHARS = 1000;
/** Range of the model's duration control: speed 2 halves the duration, 0.5 doubles it. */
export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2;

const MODEL_ID = "indextts";
/** Sampling is seeded so the same sentence sounds the same when it is played again. */
const SEED = 42;
const START_TIMEOUT_MS = 30_000;

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
 * `unavailable`: turned off, or the engine, the model or the voices are missing (`error` says which);
 * `stopped`: installed, not running yet; `starting`; `ready`; `error`: the last start failed.
 */
export type SpeechState = "unavailable" | "stopped" | "starting" | "ready" | "error";

export interface Speech {
  readonly state: SpeechState;
  readonly error: string | undefined;
  voices(): Promise<Voice[]>;
  /** One utterance as a WAV file. Rejects with SpeechError, or the signal's reason when aborted. */
  synthesize(req: SpeechRequest, signal: AbortSignal): Promise<ArrayBuffer>;
  stop(): Promise<void>;
}

export type SpeechLauncher = (cfg: Config) => Speech;

function freePort(): number {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  return port;
}

class NativeSpeech implements Speech {
  private child: Bun.Subprocess | null = null;
  private base: string | null = null;
  private starting: Promise<string> | null = null;
  private failure: string | undefined;
  private readonly configPath = join(tmpdir(), `index-translator-speech-${process.pid}.json`);

  constructor(private cfg: Config) {}

  private get binary(): string {
    return join(this.cfg.audioDir, "audiocpp_server");
  }

  /** Why speech cannot run at all, checked each time so an install does not need a restart. */
  private missing(): string | undefined {
    if (!this.cfg.speech) return "reading aloud is turned off (SPEECH=0)";
    if (!existsSync(this.binary)) return "the speech engine is not installed; run bun scripts/fetch_audiocpp.ts";
    if (!existsSync(this.cfg.speechModelDir)) {
      return "the speech model is not installed; run uv run scripts/fetch_models.py --model index-tts-2.5";
    }
    return undefined;
  }

  get state(): SpeechState {
    if (this.missing()) return "unavailable";
    if (this.base) return "ready";
    if (this.starting) return "starting";
    return this.failure ? "error" : "stopped";
  }

  get error(): string | undefined {
    return this.missing() ?? (this.base || this.starting ? undefined : this.failure);
  }

  async voices(): Promise<Voice[]> {
    let files: string[];
    try {
      files = await readdir(this.cfg.voicesDir);
    } catch {
      return [];
    }
    return files
      .filter((f) => extname(f) === ".wav")
      .sort()
      .map((f) => {
        const id = basename(f, ".wav");
        return { id, name: id.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase()) };
      });
  }

  private async start(): Promise<string> {
    const port = freePort();
    await Bun.write(
      this.configPath,
      JSON.stringify({
        host: "127.0.0.1",
        port,
        backend: this.cfg.speechBackend,
        device: 0,
        threads: 4,
        lazy_load: true,
        idle_unload_ms: this.cfg.speechIdleUnload * 1000,
        models: [{ id: MODEL_ID, family: "index_tts2", path: this.cfg.speechModelDir, task: "tts", mode: "offline" }],
      }),
    );
    // The child must not outlive this process and keep its VRAM: setpriv makes the kernel kill it
    // when we die, however we die. Without setpriv only a clean shutdown stops it.
    const command = [this.binary, "--config", this.configPath, "--no-ui"];
    const guard = Bun.which("setpriv");
    const child = Bun.spawn(guard ? [guard, "--pdeathsig", "KILL", ...command] : command, {
      cwd: this.cfg.audioDir,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "inherit",
    });
    this.child = child;
    const base = `http://127.0.0.1:${port}`;
    void child.exited.then((code) => {
      if (this.child !== child) return;
      this.child = null;
      this.base = null;
      this.failure = `the speech engine exited (code ${code})`;
      console.error(`[speech] ${this.failure}`);
    });

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (this.child === child) {
      try {
        if ((await fetch(`${base}/health`)).ok) {
          this.base = base;
          this.failure = undefined;
          console.error(`[speech] engine ready on port ${port}`);
          return base;
        }
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) {
        child.kill();
        break;
      }
      await Bun.sleep(100);
    }
    this.failure ??= "the speech engine did not start";
    throw new SpeechError(this.failure);
  }

  private ready(): Promise<string> {
    if (this.base) return Promise.resolve(this.base);
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async synthesize(req: SpeechRequest, signal: AbortSignal): Promise<ArrayBuffer> {
    const missing = this.missing();
    if (missing) throw new SpeechError(missing);
    const base = await this.ready();
    signal.throwIfAborted();
    let res: Response;
    try {
      res = await fetch(`${base}/v1/audio/speech`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: MODEL_ID,
          input: req.text,
          voice_ref: join(this.cfg.voicesDir, `${req.voice}.wav`),
          options: { language: req.lang, duration_factor: 1 / req.speed, seed: SEED },
        }),
        signal,
      });
    } catch (e) {
      signal.throwIfAborted();
      throw new SpeechError(`the speech engine cannot be reached: ${e instanceof Error ? e.message : e}`);
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      throw new SpeechError(body?.error?.message ?? `the speech engine answered HTTP ${res.status}`);
    }
    return res.arrayBuffer();
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.base = null;
    if (child) {
      child.kill();
      await child.exited;
    }
    await rm(this.configPath, { force: true });
  }
}

export const nativeSpeech: SpeechLauncher = (cfg) => new NativeSpeech(cfg);

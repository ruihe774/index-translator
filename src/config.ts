import { join, resolve } from "node:path";
import { DEFAULT_MODEL_ID, findModel } from "./models";

const root = resolve(import.meta.dir, "..");

/** Slack between our token estimate and what the engine actually counts; also kept free after the prompt. */
export const CONTEXT_MARGIN = 64;

type Env = Record<string, string | undefined>;

function int(env: Env, name: string, fallback: number, { min = 0, max = Infinity } = {}): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer of at least ${min}, got "${raw}"`);
  if (n > max) throw new Error(`${name} must be at most ${max}, got "${raw}"`);
  return n;
}

function list(env: Env, name: string): string[] {
  return (env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface Config {
  host: string;
  port: number;
  publicDir: string;
  specPath: string;
  modelsDir: string;
  /** Model loaded at startup; requests that name no model use it. */
  defaultModel: string;
  /** Directory with libllama, its backend libraries and `include/llama.h`. */
  llamaDir: string;
  /** Layers to run on the GPU; -1 means all of them. */
  gpuLayers: number;
  /** CPU threads for the engine; 0 uses half the logical CPUs. */
  threads: number;
  ctxSize: number;
  maxInputTokens: number;
  /** Requests allowed to wait behind the running one. */
  maxQueue: number;
  /** Origins (e.g. "https://app.example.com") allowed to call /api/v1 cross-origin. */
  allowedOrigins: string[];
  /** Host names besides loopback and HOST that /api/v1 accepts, e.g. behind a proxy. */
  allowedHosts: string[];
  /** Open the web app in the default browser once the server is listening. */
  openBrowser: boolean;
  /** Development: reload the open page when `public/` changes or the server restarts. */
  devReload: boolean;
  /** Reading aloud; false never starts the speech engine. */
  speech: boolean;
  /** Directory with `audiocpp_server` (audio.cpp) and its backend libraries. */
  audioDir: string;
  /** Directory holding the IndexTTS-2.5 GGUF. */
  speechModelDir: string;
  /** Reference recordings (`*.wav`), one per voice. */
  voicesDir: string;
  /** audio.cpp backend for speech: `vulkan` or `cpu`. */
  speechBackend: string;
  /** Seconds without a speech request after which the speech model leaves the GPU; 0 keeps it. */
  speechIdleUnload: number;
}

export function loadConfig(env: Env = Bun.env): Config {
  const defaultModel = env.DEFAULT_MODEL ?? DEFAULT_MODEL_ID;
  if (!findModel(defaultModel)) throw new Error(`DEFAULT_MODEL "${defaultModel}" is not a known model`);
  const ctxSize = int(env, "CTX_SIZE", 65536, { min: 1 });
  const maxInputTokens = int(env, "MAX_INPUT_TOKENS", 28000, { min: 1 });
  // The prompt, the margin and at least one output token must fit: MAX_INPUT_TOKENS + CONTEXT_MARGIN < CTX_SIZE.
  const largestInput = ctxSize - CONTEXT_MARGIN - 1;
  if (largestInput < 1) throw new Error(`CTX_SIZE must be at least ${CONTEXT_MARGIN + 2}, got ${ctxSize}`);
  if (maxInputTokens > largestInput) {
    throw new Error(
      `MAX_INPUT_TOKENS must be at most ${largestInput} for CTX_SIZE=${ctxSize} (MAX_INPUT_TOKENS + ${CONTEXT_MARGIN} must be less than CTX_SIZE, leaving room for output), got ${maxInputTokens}`,
    );
  }
  return {
    host: env.HOST ?? "127.0.0.1",
    port: int(env, "PORT", 3000, { max: 65535 }),
    // Resolved so a relative path, a trailing slash or "./" cannot break the static traversal check.
    publicDir: resolve(env.PUBLIC_DIR || join(root, "public")),
    specPath: join(root, "docs", "openapi.yaml"),
    modelsDir: env.MODELS_DIR ?? join(root, "models"),
    defaultModel,
    llamaDir: resolve(env.LLAMA_DIR || join(root, "vendor", "llama.cpp")),
    gpuLayers: env.GPU_LAYERS === undefined || env.GPU_LAYERS === "all" ? -1 : int(env, "GPU_LAYERS", -1),
    threads: int(env, "LLAMA_THREADS", 0),
    ctxSize,
    maxInputTokens,
    maxQueue: int(env, "MAX_QUEUE", 8),
    allowedOrigins: list(env, "ALLOWED_ORIGINS"),
    allowedHosts: list(env, "ALLOWED_HOSTS"),
    openBrowser: env.OPEN_BROWSER !== "0",
    devReload: env.DEV_RELOAD === "1",
    speech: env.SPEECH !== "0",
    audioDir: resolve(env.AUDIO_DIR || join(root, "vendor", "audio.cpp")),
    speechModelDir: resolve(env.SPEECH_MODEL_DIR || join(env.MODELS_DIR ?? join(root, "models"), "IndexTTS2.5-GGUF")),
    voicesDir: resolve(env.VOICES_DIR || join(root, "voices")),
    speechBackend: env.SPEECH_BACKEND || "vulkan",
    speechIdleUnload: int(env, "SPEECH_IDLE_UNLOAD", 300),
  };
}

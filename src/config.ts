import { join, resolve } from "node:path";

import { parseDomainRule, parseHostRule, parseOriginRule } from "./access";
import { DEFAULT_MODEL_ID, findModel } from "./models";

const root = resolve(import.meta.dir, "..");

/** Slack between our token estimate and what the engine actually counts; also kept free after the prompt. */
export const CONTEXT_MARGIN = 64;

type Env = Record<string, string | undefined>;

function int(env: Env, name: string, fallback: number, { min = 0, max = Infinity } = {}): number {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${name} must be an integer of at least ${min}, got "${raw}"`);
  }
  if (n > max) {
    throw new Error(`${name} must be at most ${max}, got "${raw}"`);
  }
  return n;
}

function list(env: Env, name: string): string[] {
  return (env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const SPEECH_BACKENDS = ["vulkan", "cuda", "cpu"] as const;
export type SpeechBackend = (typeof SPEECH_BACKENDS)[number];

function speechBackend(env: Env): SpeechBackend {
  const raw = env.SPEECH_BACKEND || "vulkan";
  const backend = SPEECH_BACKENDS.find((b) => b === raw);
  if (!backend) {
    throw new Error(`SPEECH_BACKEND must be one of ${SPEECH_BACKENDS.join(", ")}, got "${raw}"`);
  }
  return backend;
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
  /** CPU threads for the engine; 0 uses the performance cores (at most 8, at most the CPUs this process may use). */
  threads: number;
  /** Multi-token prediction for a model with an MTP layer, where the GPU has the memory for it (src/llama-ffi.ts). */
  mtp: boolean;
  ctxSize: number;
  maxInputTokens: number;
  /** Requests allowed to wait behind the running one. */
  maxQueue: number;
  /** Origins (e.g. "https://app.example.com") allowed to call /api/v1 cross-origin. */
  allowedOrigins: string[];
  /** Host names besides loopback and HOST that /api/v1 accepts, e.g. behind a proxy. */
  allowedHosts: string[];
  /** Domains whose pages `POST /webpage` may open (`example.com`, `*.example.com`, `*`); none turns it off. */
  allowedWebpageDomains: string[];
  /** Open the web app in the default browser once the server is listening. */
  openBrowser: boolean;
  /** Development: reload the open page when `public/` changes or the server restarts. */
  devReload: boolean;
  /** Reading aloud; false never loads the speech engine. */
  speech: boolean;
  /** Directory with `libaudiocpp` (audio.cpp's C API), as scripts/build_audiocpp.ts leaves it. */
  audioDir: string;
  /** Directory holding the IndexTTS-2.5 GGUF. */
  speechModelDir: string;
  /** Directory holding the BS-RoFormer GGUF that takes the voice out of an uploaded sample; without it samples are used as they are. */
  separationModelDir: string;
  /** Reference recordings (`*.wav`), one per voice. */
  voicesDir: string;
  /** audio.cpp backend for speech: `vulkan`, `cuda` (the build of `build_audiocpp.ts --cuda`, which the AppImage with CUDA sets) or `cpu`. */
  speechBackend: SpeechBackend;
  /** Seconds without a speech request after which the speech model leaves the GPU; 0 keeps it. */
  speechIdleUnload: number;
  /** Transcription (`POST /transcriptions`, a preview), on the speech engine. */
  transcribe: boolean;
  /** Directory holding the MOSS-Transcribe-Diarize GGUF. */
  transcribeModelDir: string;
  /** Sentence segmentation (`POST /segment`); false never loads ONNX Runtime. */
  segment: boolean;
  /** Directory with the ONNX Runtime library, as scripts/fetch_onnxruntime.ts leaves it. */
  onnxruntimeDir: string;
  /** Directory holding SaT's `model.onnx` and `tokenizer.json`. */
  segmentModelDir: string;
  /** CPU threads for segmentation; 0 uses the performance cores, like `threads`. */
  segmentThreads: number;
  /** Seconds without a segmentation (or alignment) request after which its model is freed; 0 keeps it. */
  segmentIdleUnload: number;
  /** Sentence alignment (`POST /align`, LaBSE on the segmentation thread); false never loads its model. */
  align: boolean;
  /** Directory holding LaBSE's `model.onnx`, `vocab.txt` and `dense.safetensors`. */
  alignModelDir: string;
}

/** Every setting, by its environment variable; the command-line flag is the lowercase name with dashes (`--port`). */
export const SETTING_NAMES = [
  "HOST",
  "PORT",
  "ALLOWED_ORIGINS",
  "ALLOWED_HOSTS",
  "ALLOWED_WEBPAGE_DOMAINS",
  "MODELS_DIR",
  "DEFAULT_MODEL",
  "CTX_SIZE",
  "MAX_INPUT_TOKENS",
  "MAX_QUEUE",
  "GPU_LAYERS",
  "LLAMA_THREADS",
  "LLAMA_DIR",
  "MTP",
  "PUBLIC_DIR",
  "SPEECH",
  "AUDIO_DIR",
  "SPEECH_MODEL_DIR",
  "SEPARATION_MODEL_DIR",
  "VOICES_DIR",
  "SPEECH_BACKEND",
  "SPEECH_IDLE_UNLOAD",
  "TRANSCRIBE",
  "TRANSCRIBE_MODEL_DIR",
  "SEGMENT",
  "ONNXRUNTIME_DIR",
  "SEGMENT_MODEL_DIR",
  "SEGMENT_THREADS",
  "SEGMENT_IDLE_UNLOAD",
  "ALIGN",
  "ALIGN_MODEL_DIR",
  "DEV_RELOAD",
  "OPEN_BROWSER",
] as const;

const flagOf = (name: string) => `--${name.toLowerCase().replaceAll("_", "-")}`;

/** `--port 8080` or `--port=8080` as `{ PORT: "8080" }`. An unknown argument or a missing value throws. */
export function parseArgs(argv: readonly string[]): Env {
  const byFlag = new Map<string, string>(SETTING_NAMES.map((n) => [flagOf(n), n]));
  const out: Env = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.indexOf("=");
    const flag = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg;
    const name = byFlag.get(flag);
    if (!name) {
      throw new Error(`unknown argument "${arg}"; settings are ${[...byFlag.keys()].join(", ")}`);
    }
    if (arg !== flag) {
      out[name] = arg.slice(eq + 1);
    } else {
      const value = argv[++i];
      if (value === undefined) {
        throw new Error(`${flag} needs a value`);
      }
      out[name] = value;
    }
  }
  return out;
}

/** A directory setting, resolved so a relative path or a trailing slash cannot surprise; empty means `fallback`. */
const dir = (env: Env, name: string, fallback: string) => resolve(env[name] || fallback);

/** Settings come from `environment`, overridden by the command-line flags in `argv`. */
export function loadConfig(environment: Env = Bun.env, argv: readonly string[] = []): Config {
  const env: Env = { ...environment, ...parseArgs(argv) };
  const defaultModel = env.DEFAULT_MODEL ?? DEFAULT_MODEL_ID;
  if (!findModel(defaultModel)) {
    throw new Error(`DEFAULT_MODEL "${defaultModel}" is not a known model`);
  }
  const ctxSize = int(env, "CTX_SIZE", 65_536, { min: 1 });
  const maxInputTokens = int(env, "MAX_INPUT_TOKENS", 28_000, { min: 1 });
  // The prompt, the margin and at least one output token must fit: MAX_INPUT_TOKENS + CONTEXT_MARGIN < CTX_SIZE.
  const largestInput = ctxSize - CONTEXT_MARGIN - 1;
  if (largestInput < 1) {
    throw new Error(`CTX_SIZE must be at least ${CONTEXT_MARGIN + 2}, got ${ctxSize}`);
  }
  if (maxInputTokens > largestInput) {
    throw new Error(
      `MAX_INPUT_TOKENS must be at most ${largestInput} for CTX_SIZE=${ctxSize} (MAX_INPUT_TOKENS + ${CONTEXT_MARGIN} must be less than CTX_SIZE, leaving room for output), got ${maxInputTokens}`,
    );
  }
  const modelsDir = env.MODELS_DIR ?? join(root, "models");
  const allowedOrigins = list(env, "ALLOWED_ORIGINS");
  const allowedHosts = list(env, "ALLOWED_HOSTS");
  const allowedWebpageDomains = list(env, "ALLOWED_WEBPAGE_DOMAINS");
  // Fail at startup on an entry that could never match, rather than refuse requests later.
  for (const entry of allowedOrigins) {
    parseOriginRule(entry);
  }
  for (const entry of allowedHosts) {
    parseHostRule(entry);
  }
  for (const entry of allowedWebpageDomains) {
    parseDomainRule(entry);
  }
  return {
    host: env.HOST ?? "127.0.0.1",
    port: int(env, "PORT", 3000, { max: 65_535 }),
    // Resolved so a relative path, a trailing slash or "./" cannot break the static traversal check.
    publicDir: dir(env, "PUBLIC_DIR", join(root, "public")),
    specPath: join(root, "docs", "openapi.yaml"),
    modelsDir,
    defaultModel,
    llamaDir: dir(env, "LLAMA_DIR", join(root, "vendor", "llama.cpp")),
    gpuLayers: env.GPU_LAYERS === undefined || env.GPU_LAYERS === "all" ? -1 : int(env, "GPU_LAYERS", -1),
    threads: int(env, "LLAMA_THREADS", 0),
    mtp: env.MTP !== "0",
    ctxSize,
    maxInputTokens,
    maxQueue: int(env, "MAX_QUEUE", 8),
    allowedOrigins,
    allowedHosts,
    allowedWebpageDomains,
    openBrowser: env.OPEN_BROWSER !== "0",
    devReload: env.DEV_RELOAD === "1",
    speech: env.SPEECH !== "0",
    audioDir: dir(env, "AUDIO_DIR", join(root, "vendor", "audio.cpp")),
    speechModelDir: dir(env, "SPEECH_MODEL_DIR", join(modelsDir, "IndexTTS2.5-GGUF")),
    separationModelDir: dir(env, "SEPARATION_MODEL_DIR", join(modelsDir, "BS-RoFormer-ep368-GGUF")),
    voicesDir: dir(env, "VOICES_DIR", join(root, "voices")),
    speechBackend: speechBackend(env),
    speechIdleUnload: int(env, "SPEECH_IDLE_UNLOAD", 300),
    transcribe: env.TRANSCRIBE !== "0",
    transcribeModelDir: dir(env, "TRANSCRIBE_MODEL_DIR", join(modelsDir, "MOSS-Transcribe-Diarize-GGUF")),
    segment: env.SEGMENT !== "0",
    onnxruntimeDir: dir(env, "ONNXRUNTIME_DIR", join(root, "vendor", "onnxruntime")),
    segmentModelDir: dir(env, "SEGMENT_MODEL_DIR", join(modelsDir, "sat-3l-sm")),
    segmentThreads: int(env, "SEGMENT_THREADS", 0),
    segmentIdleUnload: int(env, "SEGMENT_IDLE_UNLOAD", 300),
    align: env.ALIGN !== "0",
    alignModelDir: dir(env, "ALIGN_MODEL_DIR", join(modelsDir, "labse")),
  };
}

const SETTING_HELP: Record<(typeof SETTING_NAMES)[number], string> = {
  HOST: "address to listen on (default 127.0.0.1; no authentication, keep it on loopback)",
  PORT: "port to listen on (default 3000)",
  ALLOWED_ORIGINS:
    "browser origins allowed to call the API cross-origin, comma separated: https://app.example.com, https://*.example.com",
  ALLOWED_HOSTS:
    "extra Host header names (comma separated: app.example.com, *.example.com, name:port), needed when HOST is 0.0.0.0 or ::",
  ALLOWED_WEBPAGE_DOMAINS:
    "domains whose web pages may be fetched for translation, comma separated: example.com, *.example.com, or * for any (default none: off)",
  MODELS_DIR: "directory with the GGUF translation models (default models/)",
  DEFAULT_MODEL: "model loaded at startup (default index-translate-9b)",
  CTX_SIZE: "context size shared by prompt and output (default 65536)",
  MAX_INPUT_TOKENS: "largest accepted prompt, in tokens (default 28000)",
  MAX_QUEUE: "requests allowed to wait (default 8)",
  GPU_LAYERS: "`all` (default), a layer count, or 0 to run on the processor",
  LLAMA_THREADS: "CPU threads for decoding (default the performance cores: P-cores or big cores, at most 8)",
  LLAMA_DIR: "directory with libllama and its backends (default vendor/llama.cpp)",
  MTP: "0 turns multi-token prediction off (default on where all layers are on a GPU with 16 GiB or more)",
  PUBLIC_DIR: "directory with the web app (default public/)",
  SPEECH: "0 turns reading aloud off (default on)",
  AUDIO_DIR: "directory with libaudiocpp (default vendor/audio.cpp)",
  SPEECH_MODEL_DIR: "directory with the speech model (default MODELS_DIR/IndexTTS2.5-GGUF)",
  SEPARATION_MODEL_DIR: "directory with the voice separation model (default MODELS_DIR/BS-RoFormer-ep368-GGUF)",
  VOICES_DIR: "directory with the voice recordings, one .wav each (default voices/)",
  SPEECH_BACKEND: "speech backend: vulkan (default), cuda (for an engine built with --cuda) or cpu",
  SPEECH_IDLE_UNLOAD: "seconds without speech before the model is freed; 0 never (default 300)",
  TRANSCRIBE: "0 turns transcription (a preview) off (default on)",
  TRANSCRIBE_MODEL_DIR: "directory with the transcription model (default MODELS_DIR/MOSS-Transcribe-Diarize-GGUF)",
  SEGMENT: "0 turns sentence segmentation for reading aloud off (default on)",
  ONNXRUNTIME_DIR: "directory with the ONNX Runtime library (default vendor/onnxruntime)",
  SEGMENT_MODEL_DIR: "directory with the sentence segmentation model (default MODELS_DIR/sat-3l-sm)",
  SEGMENT_THREADS: "CPU threads for sentence segmentation and alignment (default the performance cores, at most 8)",
  SEGMENT_IDLE_UNLOAD: "seconds without segmentation (or alignment) before its model is freed; 0 never (default 300)",
  ALIGN: "0 turns matching the sentences of a source and its translation off (default on)",
  ALIGN_MODEL_DIR: "directory with the sentence alignment model (default MODELS_DIR/labse)",
  DEV_RELOAD: "1 reloads open pages when public/ changes (development)",
  OPEN_BROWSER: "0 does not open the web app at startup (default on)",
};

/** What `--help` prints. */
export function helpText(command = "bun src/server.ts"): string {
  const rows = SETTING_NAMES.map((n) => [`${flagOf(n)} <value>`, SETTING_HELP[n]] as const);
  const width = Math.max(...rows.map(([f]) => f.length));
  return [
    "Index Translator: a local translator that runs on your GPU.",
    "",
    `Usage: ${command} [--setting value ...]`,
    "",
    "Every setting is a flag (--port 8080 or --port=8080) or an environment variable (PORT=8080);",
    "the flag wins. Settings:",
    "",
    ...rows.map(([f, d]) => `  ${f.padEnd(width)}  ${d}`),
    "",
    "  -h, --help  print this text",
    "",
  ].join("\n");
}

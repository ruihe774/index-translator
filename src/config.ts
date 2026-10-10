import { join, resolve } from "node:path";
import { DEFAULT_MODEL_ID, findModel } from "./models";

const root = resolve(import.meta.dir, "..");

function int(name: string, fallback: number): number {
  const raw = Bun.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return n;
}

export interface Config {
  host: string;
  port: number;
  publicDir: string;
  specPath: string;
  modelsDir: string;
  /** Model loaded at startup; requests that name no model use it. */
  defaultModel: string;
  llamaBin: string;
  /** 0 picks a free port for each engine start. */
  llamaPort: number;
  gpuLayers: string;
  /** Extra llama-server arguments, appended last so they override the defaults. */
  llamaExtraArgs: string[];
  ctxSize: number;
  maxInputTokens: number;
  /** Requests allowed to wait behind the running one. */
  maxQueue: number;
}

export function loadConfig(): Config {
  const defaultModel = Bun.env.DEFAULT_MODEL ?? DEFAULT_MODEL_ID;
  if (!findModel(defaultModel)) throw new Error(`DEFAULT_MODEL "${defaultModel}" is not a known model`);
  return {
    host: Bun.env.HOST ?? "127.0.0.1",
    port: int("PORT", 3000),
    publicDir: Bun.env.PUBLIC_DIR ?? join(root, "public"),
    specPath: join(root, "docs", "openapi.yaml"),
    modelsDir: Bun.env.MODELS_DIR ?? join(root, "models"),
    defaultModel,
    llamaBin: Bun.env.LLAMA_SERVER_BIN ?? join(root, "vendor", "llama.cpp", "llama-server"),
    llamaPort: int("LLAMA_PORT", 0),
    gpuLayers: Bun.env.GPU_LAYERS ?? "all",
    llamaExtraArgs: (Bun.env.LLAMA_EXTRA_ARGS ?? "").split(/\s+/).filter(Boolean),
    ctxSize: int("CTX_SIZE", 65536),
    maxInputTokens: int("MAX_INPUT_TOKENS", 28000),
    maxQueue: int("MAX_QUEUE", 8),
  };
}

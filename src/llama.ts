// llama-server lifecycle and the calls the backend needs from it: loading a model, token counting
// and streamed generation. One model is loaded at a time; switching models restarts the engine.

import { join } from "node:path";
import type { Subprocess } from "bun";
import type { Config } from "./config";
import type { ModelSpec } from "./models";

export type EngineState = "stopped" | "loading" | "ready" | "error";

export type FinishReason = "stop" | "length";

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
}

export interface EngineTimings {
  prompt_ms: number;
  generation_ms: number;
  tokens_per_second: number;
}

export type GenerationEvent =
  | { type: "delta"; text: string }
  | { type: "done"; finishReason: FinishReason; usage: Usage; timings: EngineTimings };

export class EngineError extends Error {}

/** A running llama-server, as seen by the engine. */
export interface Running {
  url: string;
  /** Resolves with the exit code once the process is gone, for any reason. */
  exited: Promise<number>;
  /** Asks the process to stop; the engine waits on `exited`. */
  stop(): void;
}

/** Starts an engine for one model. Replaceable so tests can run without the binary or the weights. */
export type Launcher = (model: ModelSpec, cfg: Config) => Promise<Running>;

// Tokens the chat template adds around the user message; replaced by a measured value once the model is up.
const FALLBACK_TEMPLATE_OVERHEAD = 32;
const LOAD_TIMEOUT_MS = 10 * 60_000;

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port!;
  await probe.stop(true);
  return port;
}

export const launchLlamaServer: Launcher = async (model, cfg) => {
  const modelPath = join(cfg.modelsDir, model.file);
  if (!(await Bun.file(modelPath).exists())) {
    throw new EngineError(`model not found at ${modelPath}; run: uv run scripts/fetch_models.py`);
  }
  if (!(await Bun.file(cfg.llamaBin).exists())) {
    throw new EngineError(`llama-server not found at ${cfg.llamaBin}; run: bun scripts/fetch_llama.ts`);
  }
  const port = cfg.llamaPort || (await freePort());

  const child: Subprocess = Bun.spawn(
    [
      cfg.llamaBin,
      "--model", modelPath,
      "--alias", model.id,
      "--host", "127.0.0.1",
      "--port", String(port),
      "--gpu-layers", cfg.gpuLayers,
      "--ctx-size", String(cfg.ctxSize),
      // One slot, so a single request may use the whole context window.
      "--parallel", "1",
      "--no-context-shift",
      "--jinja",
      "--chat-template-kwargs", '{"enable_thinking":false}',
      "--no-webui",
      "--offline",
      ...cfg.llamaExtraArgs,
    ],
    { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
  );

  return {
    url: `http://127.0.0.1:${port}`,
    exited: child.exited,
    stop() {
      child.kill("SIGTERM");
      const killer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      void child.exited.then(() => clearTimeout(killer));
    },
  };
};

/** Streams a response body; a connection that drops (the engine died) becomes an EngineError. */
async function* readBody(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  try {
    yield* body;
  } catch (e: any) {
    if (signal?.aborted) throw e;
    throw new EngineError(`llama-server connection lost: ${e?.message ?? e}`);
  }
}

export class Engine {
  state: EngineState = "stopped";
  /** The model whose engine is running or loading. */
  loaded?: ModelSpec;
  error?: string;
  templateOverhead = FALLBACK_TEMPLATE_OVERHEAD;

  private baseUrl = "";
  private running?: Running;
  /** Bumped by every load() and unload(); a load that finds it changed has been superseded. */
  private epoch = 0;

  constructor(
    private cfg: Config,
    private launch: Launcher = launchLlamaServer,
  ) {}

  /**
   * Makes `model` the loaded one, replacing any other engine. Callers must hold the queue slot,
   * so no generation runs while the engine is being swapped.
   */
  async load(model: ModelSpec): Promise<void> {
    if (this.state === "ready" && this.loaded?.id === model.id) return;
    // A client that gave up frees the queue slot while its load is still in flight, so a later load
    // can start before this one ends. Whichever load is newest wins; an older one stops its own
    // process and leaves the engine state alone.
    const epoch = ++this.epoch;
    await this.stopRunning();
    this.state = "loading";
    this.loaded = model;
    this.error = undefined;
    try {
      const running = await this.launch(model, this.cfg);
      if (epoch !== this.epoch) {
        running.stop();
        await running.exited;
        throw new EngineError("the model load was superseded by a newer one");
      }
      this.running = running;
      this.baseUrl = running.url;
      void running.exited.then((code) => {
        if (this.running !== running) return;
        this.running = undefined;
        this.loaded = undefined;
        this.state = "error";
        this.error = `llama-server exited with code ${code}`;
        console.error(`[engine] ${this.error}`);
      });
      await this.waitUntilReady(running);
      this.templateOverhead = await this.measureTemplateOverhead();
      this.state = "ready";
      console.error(`[engine] ${model.id} ready at ${this.baseUrl} (template overhead ${this.templateOverhead} tokens)`);
    } catch (e) {
      if (epoch !== this.epoch) throw e instanceof EngineError ? e : new EngineError(String(e));
      const message = e instanceof Error ? e.message : String(e);
      await this.stopRunning();
      this.state = "error";
      this.error = message;
      console.error(`[engine] could not load ${model.id}: ${message}`);
      throw e instanceof EngineError ? e : new EngineError(message);
    }
  }

  /** Stops the running engine, if any. */
  async unload(): Promise<void> {
    this.epoch++;
    await this.stopRunning();
  }

  private async stopRunning(): Promise<void> {
    const running = this.running;
    this.running = undefined;
    this.loaded = undefined;
    this.baseUrl = "";
    this.state = "stopped";
    if (!running) return;
    running.stop();
    await running.exited;
  }

  private async waitUntilReady(running: Running): Promise<void> {
    const deadline = Date.now() + LOAD_TIMEOUT_MS;
    while (this.running === running) {
      if (Date.now() > deadline) throw new EngineError("timed out waiting for the model to load");
      try {
        const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return;
      } catch {
        // not listening yet
      }
      await Bun.sleep(500);
    }
    throw new EngineError(this.error ?? "the engine stopped while loading");
  }

  private async measureTemplateOverhead(): Promise<number> {
    try {
      const res = await this.post("/apply-template", { messages: [{ role: "user", content: "" }] });
      const { prompt } = (await res.json()) as { prompt: string };
      return await this.tokenize(prompt, true);
    } catch (e) {
      console.error(`[engine] could not measure template overhead, assuming ${FALLBACK_TEMPLATE_OVERHEAD}: ${e}`);
      return FALLBACK_TEMPLATE_OVERHEAD;
    }
  }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e: any) {
      if (signal?.aborted) throw e;
      throw new EngineError(`llama-server unreachable: ${e?.message ?? e}`);
    }
    if (!res.ok) {
      const text = await res.text();
      let message = text;
      try {
        message = JSON.parse(text).error?.message ?? text;
      } catch {}
      throw new EngineError(`llama-server ${path} failed (HTTP ${res.status}): ${message}`);
    }
    return res;
  }

  private async tokenize(content: string, parseSpecial: boolean, signal?: AbortSignal): Promise<number> {
    const res = await this.post("/tokenize", { content, add_special: false, parse_special: parseSpecial }, signal);
    const { tokens } = (await res.json()) as { tokens: unknown[] };
    return tokens.length;
  }

  /**
   * Tokens a user message with this content occupies in the context, chat template included.
   * Counted by the engine that is running now, without waiting for a generation (llama-server
   * answers /tokenize while one runs). Throws EngineError when no engine is ready, so a stopped
   * or stale base URL is never used. The check and the request start in the same tick, so the
   * URL cannot change between them; a swap that kills the process mid-request surfaces as EngineError.
   */
  async countPromptTokens(content: string, signal?: AbortSignal): Promise<number> {
    if (this.state !== "ready") throw new EngineError(`the engine is ${this.state}`);
    const overhead = this.templateOverhead;
    return (await this.tokenize(content, false, signal)) + overhead;
  }

  async *generate(prompt: string, maxTokens: number, signal?: AbortSignal): AsyncGenerator<GenerationEvent> {
    const res = await this.post(
      "/v1/chat/completions",
      {
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: maxTokens,
        stream: true,
        stream_options: { include_usage: true },
        cache_prompt: false,
      },
      signal,
    );

    let finishReason: FinishReason | undefined;
    let usage: Usage | undefined;
    let timings: EngineTimings = { prompt_ms: 0, generation_ms: 0, tokens_per_second: 0 };

    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of readBody(res.body!, signal)) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;

        const msg = JSON.parse(data);
        if (msg.error) throw new EngineError(`generation failed: ${msg.error.message ?? JSON.stringify(msg.error)}`);

        const choice = msg.choices?.[0];
        const text = choice?.delta?.content;
        if (text) yield { type: "delta", text };
        if (choice?.finish_reason) finishReason = choice.finish_reason === "length" ? "length" : "stop";
        if (msg.usage) {
          usage = { prompt_tokens: msg.usage.prompt_tokens, completion_tokens: msg.usage.completion_tokens };
        }
        if (msg.timings) {
          timings = {
            prompt_ms: Math.round(msg.timings.prompt_ms ?? 0),
            generation_ms: Math.round(msg.timings.predicted_ms ?? 0),
            tokens_per_second: Number((msg.timings.predicted_per_second ?? 0).toFixed(2)),
          };
        }
      }
    }

    if (!finishReason) throw new EngineError("generation ended without a finish reason");
    yield { type: "done", finishReason, usage: usage ?? { prompt_tokens: 0, completion_tokens: 0 }, timings };
  }
}

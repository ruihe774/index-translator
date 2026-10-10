// llama-server lifecycle and the two calls the backend needs from it: token counting and streamed generation.

import type { Subprocess } from "bun";
import type { Config } from "./config";

export type EngineState = "loading" | "ready" | "error" | "stopped";

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

// Tokens the chat template adds around the user message; replaced by a measured value once the model is up.
const FALLBACK_TEMPLATE_OVERHEAD = 32;
const MAX_RESTARTS = 5;

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port!;
  await probe.stop(true);
  return port;
}

export class Engine {
  state: EngineState = "stopped";
  error?: string;
  templateOverhead = FALLBACK_TEMPLATE_OVERHEAD;

  private baseUrl = "";
  private child?: Subprocess;
  private restarts = 0;

  constructor(private cfg: Config) {}

  async start(): Promise<void> {
    this.state = "loading";
    this.error = undefined;
    if (this.cfg.llamaUrl) {
      this.baseUrl = this.cfg.llamaUrl.replace(/\/+$/, "");
    } else {
      await this.spawn();
    }
    void this.waitUntilReady(this.child);
  }

  async stop(): Promise<void> {
    this.state = "stopped";
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    child.kill("SIGTERM");
    const killer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    await child.exited;
    clearTimeout(killer);
  }

  private async spawn(): Promise<void> {
    const { cfg } = this;
    if (!(await Bun.file(cfg.modelPath).exists())) {
      throw new EngineError(`model not found at ${cfg.modelPath}; run: uv run scripts/fetch_models.py`);
    }
    if (!(await Bun.file(cfg.llamaBin).exists())) {
      throw new EngineError(`llama-server not found at ${cfg.llamaBin}; run: bun scripts/fetch_llama.ts`);
    }
    const port = cfg.llamaPort || (await freePort());
    this.baseUrl = `http://127.0.0.1:${port}`;

    const child = Bun.spawn(
      [
        cfg.llamaBin,
        "--model", cfg.modelPath,
        "--alias", cfg.modelName,
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
    this.child = child;

    void child.exited.then((code) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.state = "error";
      this.error = `llama-server exited with code ${code}`;
      console.error(`[engine] ${this.error}`);
      if (++this.restarts > MAX_RESTARTS) {
        console.error("[engine] giving up after repeated failures");
        return;
      }
      setTimeout(() => {
        if (this.state !== "error") return;
        console.error(`[engine] restarting (attempt ${this.restarts}/${MAX_RESTARTS})`);
        this.start().catch((e) => {
          this.state = "error";
          this.error = String(e?.message ?? e);
        });
      }, 2000 * this.restarts);
    });
  }

  private async waitUntilReady(child: Subprocess | undefined): Promise<void> {
    while (this.state === "loading" && this.child === child) {
      try {
        const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          this.templateOverhead = await this.measureTemplateOverhead();
          if (this.state !== "loading" || this.child !== child) return;
          this.state = "ready";
          this.restarts = 0;
          console.error(`[engine] ready at ${this.baseUrl} (template overhead ${this.templateOverhead} tokens)`);
          return;
        }
      } catch {
        // not listening yet
      }
      await Bun.sleep(500);
    }
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

  /** Tokens a user message with this content occupies in the context, chat template included. */
  async countPromptTokens(content: string, signal?: AbortSignal): Promise<number> {
    return (await this.tokenize(content, false, signal)) + this.templateOverhead;
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
    for await (const chunk of res.body!) {
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

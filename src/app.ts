// HTTP surface: REST + SSE API under /api/v1 and static files for the web app.

import type { Server } from "bun";
import { join, normalize, sep } from "node:path";
import type { Config } from "./config";
import { Engine, EngineError, type EngineTimings, type FinishReason, type Usage } from "./llama";
import { LANGUAGES, buildPrompt, type PromptInput } from "./prompt";
import { QueueFullError, SlotQueue, type Ticket } from "./queue";

const API = "/api/v1";
// Slack between our token estimate and what the engine actually counts.
const CONTEXT_MARGIN = 64;
const DEFAULT_OUTPUT_RATIO = 4;
const DEFAULT_OUTPUT_FLOOR = 512;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const KEEPALIVE_MS = 15_000;

class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
    public headers?: Record<string, string>,
  ) {
    super(message);
  }
}

function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return Response.json(body, { status, headers });
}

function errorResponse(e: unknown): Response {
  if (e instanceof ApiError) {
    return json({ error: { code: e.code, message: e.message, details: e.details } }, e.status, e.headers);
  }
  if (e instanceof EngineError) {
    return json({ error: { code: "engine_error", message: e.message } }, 502);
  }
  console.error("[api] unexpected error:", e);
  return json({ error: { code: "internal_error", message: "internal server error" } }, 500);
}

interface TranslateRequest extends PromptInput {
  maxOutputTokens?: number;
  stream: boolean;
}

function invalid(message: string, field?: string): ApiError {
  return new ApiError(400, "invalid_request", message, field ? { field } : undefined);
}

function optionalString(body: Record<string, unknown>, field: string, maxLength: number): string | undefined {
  const v = body[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw invalid(`${field} must be a string`, field);
  if (v.length > maxLength) throw invalid(`${field} must be at most ${maxLength} characters`, field);
  return v;
}

function optionalStringArray(body: Record<string, unknown>, field: string): string[] | undefined {
  const v = body[field];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) {
    throw invalid(`${field} must be an array of strings`, field);
  }
  return v as string[];
}

async function parseBody(req: Request): Promise<Record<string, unknown>> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    throw new ApiError(413, "body_too_large", `request body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw invalid("request body must be valid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw invalid("request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function parseTranslateRequest(req: Request, body: Record<string, unknown>): TranslateRequest {
  if (typeof body.text !== "string" || !body.text.trim()) throw invalid("text must be a non-empty string", "text");
  const targetLang = optionalString(body, "target_lang", 64);
  if (!targetLang?.trim()) throw invalid("target_lang must be a non-empty string", "target_lang");

  const glossary = body.glossary;
  if (glossary !== undefined && glossary !== null) {
    if (typeof glossary !== "object" || Array.isArray(glossary)) {
      throw invalid("glossary must be an object mapping source terms to target terms", "glossary");
    }
    if (Object.values(glossary).some((v) => typeof v !== "string")) {
      throw invalid("glossary values must be strings", "glossary");
    }
  }

  const maxOutputTokens = body.max_output_tokens;
  if (maxOutputTokens !== undefined && maxOutputTokens !== null) {
    if (!Number.isInteger(maxOutputTokens) || (maxOutputTokens as number) < 1) {
      throw invalid("max_output_tokens must be a positive integer", "max_output_tokens");
    }
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    throw invalid("stream must be a boolean", "stream");
  }

  return {
    text: body.text,
    targetLang,
    sourceLang: optionalString(body, "source_lang", 64),
    glossary: (glossary as Record<string, string> | null) ?? undefined,
    hardConstraints: optionalStringArray(body, "hard_constraints"),
    softConstraints: optionalStringArray(body, "soft_constraints"),
    genre: optionalString(body, "genre", 64),
    maxOutputTokens: (maxOutputTokens as number | null) ?? undefined,
    stream: body.stream === true || (req.headers.get("accept") ?? "").includes("text/event-stream"),
  };
}

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

/**
 * Cleans the model output while streaming: drops a leading (normally empty) thinking block
 * and the whitespace at either end, neither of which is part of the translation.
 */
export class OutputCleaner {
  private head = "";
  private inBody = false;
  private held = "";

  push(text: string): string {
    if (!this.inBody) {
      this.head = (this.head + text).trimStart();
      if (this.head.startsWith(THINK_OPEN)) {
        const end = this.head.indexOf(THINK_CLOSE);
        if (end < 0) return "";
        this.head = this.head.slice(end + THINK_CLOSE.length).trimStart();
      }
      if (!this.head || THINK_OPEN.startsWith(this.head)) return "";
      text = this.head;
      this.inBody = true;
    } else {
      text = this.held + text;
    }
    const body = text.trimEnd();
    this.held = text.slice(body.length);
    return body;
  }

  /** Output held back because it could still have turned out to be a thinking tag. */
  flush(): string {
    if (this.inBody || this.head.startsWith(THINK_OPEN)) return "";
    this.inBody = true;
    return this.head.trimEnd();
  }
}

interface Budget {
  prompt: string;
  promptTokens: number;
  maxOutputTokens: number;
}

interface Result {
  translation: string;
  finish_reason: FinishReason;
  model: string;
  usage: Usage;
  timings: EngineTimings & { queue_ms: number };
}

export interface App {
  server: Server<undefined>;
  engine: Engine;
  stop(): Promise<void>;
}

export async function startApp(cfg: Config): Promise<App> {
  const engine = new Engine(cfg);
  const queue = new SlotQueue(cfg.maxQueue);
  await engine.start();

  function requireReady(): void {
    if (engine.state === "ready") return;
    if (engine.state === "loading") {
      throw new ApiError(503, "engine_loading", "the model is still loading", undefined, { "retry-after": "5" });
    }
    throw new ApiError(503, "engine_unavailable", engine.error ?? "the inference engine is not running");
  }

  async function budget(input: PromptInput, requestedOutput?: number, signal?: AbortSignal): Promise<Budget> {
    const prompt = buildPrompt(input);
    const promptTokens = await engine.countPromptTokens(prompt, signal);
    if (promptTokens > cfg.maxInputTokens) {
      throw new ApiError(413, "input_too_long", "the input exceeds the token limit for a single translation", {
        prompt_tokens: promptTokens,
        max_input_tokens: cfg.maxInputTokens,
      });
    }
    const available = cfg.ctxSize - promptTokens - CONTEXT_MARGIN;
    // A translation is rarely several times longer than its source, while a model stuck in a
    // loop will fill whatever it is given; the default leaves room for the former only.
    const fallback = promptTokens * DEFAULT_OUTPUT_RATIO + DEFAULT_OUTPUT_FLOOR;
    return { prompt, promptTokens, maxOutputTokens: Math.min(requestedOutput ?? fallback, available) };
  }

  function limits() {
    return { context_tokens: cfg.ctxSize, max_input_tokens: cfg.maxInputTokens };
  }

  async function* run(b: Budget, ticket: Ticket, signal: AbortSignal) {
    const queuedAt = performance.now();
    await ticket.ready;
    if (signal.aborted) return;
    const queueMs = Math.round(performance.now() - queuedAt);
    yield { type: "start" as const, queueMs };

    const cleaner = new OutputCleaner();
    for await (const ev of engine.generate(b.prompt, b.maxOutputTokens, signal)) {
      if (ev.type === "delta") {
        const text = cleaner.push(ev.text);
        if (text) yield { type: "delta" as const, text };
      } else {
        const rest = cleaner.flush();
        if (rest) yield { type: "delta" as const, text: rest };
        yield {
          type: "done" as const,
          finish_reason: ev.finishReason,
          usage: ev.usage.prompt_tokens ? ev.usage : { ...ev.usage, prompt_tokens: b.promptTokens },
          timings: { queue_ms: queueMs, ...ev.timings },
        };
      }
    }
  }

  function enterQueue(onPosition?: (position: number) => void): Ticket {
    try {
      return queue.enter(onPosition);
    } catch (e) {
      if (e instanceof QueueFullError) {
        throw new ApiError(429, "queue_full", "too many translations are waiting; try again later", {
          max_queue: cfg.maxQueue,
        }, { "retry-after": "10" });
      }
      throw e;
    }
  }

  async function translateJson(b: Budget, signal: AbortSignal): Promise<Response> {
    const ticket = enterQueue();
    const onAbort = () => ticket.leave();
    signal.addEventListener("abort", onAbort);
    try {
      let translation = "";
      let result: Result | undefined;
      for await (const ev of run(b, ticket, signal)) {
        if (ev.type === "delta") translation += ev.text;
        else if (ev.type === "done") {
          result = {
            translation,
            finish_reason: ev.finish_reason,
            model: cfg.modelName,
            usage: ev.usage,
            timings: ev.timings,
          };
        }
      }
      if (!result) throw new ApiError(499, "cancelled", "the request was cancelled");
      return json(result);
    } finally {
      signal.removeEventListener("abort", onAbort);
      ticket.leave();
    }
  }

  function translateSse(b: Budget, signal: AbortSignal): Response {
    const encoder = new TextEncoder();
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal.addEventListener("abort", cancel);

    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const send = (event: string, data: unknown) => {
      if (abort.signal.aborted) return;
      try {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      } catch {
        abort.abort();
      }
    };

    // Entering the queue before the response starts lets a full queue surface as a plain 429.
    const pending: number[] = [];
    let live = false;
    const ticket = enterQueue((position) => (live ? send("queued", { position }) : pending.push(position)));
    abort.signal.addEventListener("abort", () => ticket.leave());

    const stream = new ReadableStream<Uint8Array>({
      async start(c) {
        controller = c;
        live = true;
        for (const position of pending) send("queued", { position });
        const keepalive = setInterval(() => {
          try {
            c.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            abort.abort();
          }
        }, KEEPALIVE_MS);

        try {
          for await (const ev of run(b, ticket, abort.signal)) {
            if (ev.type === "start") {
              send("start", {
                model: cfg.modelName,
                prompt_tokens: b.promptTokens,
                max_output_tokens: b.maxOutputTokens,
                queue_ms: ev.queueMs,
              });
            } else if (ev.type === "delta") {
              send("delta", { text: ev.text });
            } else {
              send("done", { finish_reason: ev.finish_reason, usage: ev.usage, timings: ev.timings });
            }
          }
        } catch (e) {
          if (!abort.signal.aborted) {
            const code = e instanceof EngineError ? "engine_error" : "internal_error";
            if (code === "internal_error") console.error("[api] stream failed:", e);
            send("error", { code, message: e instanceof EngineError ? e.message : "internal server error" });
          }
        } finally {
          clearInterval(keepalive);
          signal.removeEventListener("abort", cancel);
          ticket.leave();
          try {
            c.close();
          } catch {}
        }
      },
      cancel,
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      },
    });
  }

  async function serveStatic(pathname: string): Promise<Response> {
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
    if (rel.endsWith("/")) rel += "index.html";
    const path = normalize(join(cfg.publicDir, rel));
    if (!path.startsWith(cfg.publicDir + sep)) return new Response("Not Found", { status: 404 });
    const file = Bun.file(path);
    if (!(await file.exists())) return new Response("Not Found", { status: 404 });
    return new Response(file);
  }

  const methodNotAllowed = (allow: string) =>
    errorResponse(new ApiError(405, "method_not_allowed", `use ${allow}`, undefined, { allow }));

  const server = Bun.serve({
    hostname: cfg.host,
    port: cfg.port,
    // Hard backstop; parseBody rejects anything over MAX_BODY_BYTES with a proper error body first.
    maxRequestBodySize: MAX_BODY_BYTES * 4,
    async fetch(req, server) {
      const url = new URL(req.url);
      const path = url.pathname;
      if (!path.startsWith(API + "/")) {
        if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method Not Allowed", { status: 405 });
        return serveStatic(path);
      }

      try {
        switch (path.slice(API.length)) {
          case "/health": {
            if (req.method !== "GET") return methodNotAllowed("GET");
            return json(
              {
                status: engine.state,
                error: engine.error,
                model: cfg.modelName,
                limits: limits(),
                queue: { running: queue.running, waiting: queue.depth, max_waiting: cfg.maxQueue },
              },
              engine.state === "ready" ? 200 : 503,
            );
          }
          case "/languages": {
            if (req.method !== "GET") return methodNotAllowed("GET");
            return json({ languages: LANGUAGES.map(({ code, name }) => ({ code, name })) });
          }
          case "/openapi.yaml": {
            if (req.method !== "GET") return methodNotAllowed("GET");
            return new Response(Bun.file(cfg.specPath), { headers: { "content-type": "application/yaml" } });
          }
          case "/tokenize": {
            if (req.method !== "POST") return methodNotAllowed("POST");
            const input = parseTranslateRequest(req, await parseBody(req));
            requireReady();
            const prompt = buildPrompt(input);
            const promptTokens = await engine.countPromptTokens(prompt, req.signal);
            return json({
              prompt_tokens: promptTokens,
              fits: promptTokens <= cfg.maxInputTokens,
              max_output_tokens: Math.max(0, cfg.ctxSize - promptTokens - CONTEXT_MARGIN),
              limits: limits(),
            });
          }
          case "/translate": {
            if (req.method !== "POST") return methodNotAllowed("POST");
            const input = parseTranslateRequest(req, await parseBody(req));
            requireReady();
            // A long translation can stay silent for minutes in JSON mode.
            server.timeout(req, 0);
            const b = await budget(input, input.maxOutputTokens, req.signal);
            return input.stream ? translateSse(b, req.signal) : await translateJson(b, req.signal);
          }
          default:
            throw new ApiError(404, "not_found", `no such endpoint: ${path}`);
        }
      } catch (e) {
        return errorResponse(e);
      }
    },
    error(e) {
      return errorResponse(e);
    },
  });

  return {
    server,
    engine,
    async stop() {
      await server.stop(true);
      await engine.stop();
    },
  };
}

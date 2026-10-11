// HTTP surface: REST + SSE API under /api/v1 and static files for the web app.

import type { Server } from "bun";
import { CONTEXT_MARGIN, type Config } from "./config";
import { createDevReload, DEV_PREFIX } from "./dev-reload";
import {
  Engine,
  EngineError,
  type EngineTimings,
  type FinishReason,
  type Launcher,
  launchNative,
  type Usage,
} from "./llama";
import { findModel, MODELS, type ModelSpec } from "./models";
import { buildDocumentPrompt, buildPrompt, DOCUMENT_DIRECTIONS, LANGUAGES, type PromptInput } from "./prompt";
import { QueueFullError, SlotQueue, type Ticket } from "./queue";
import {
  MAX_SAMPLE_BYTES,
  MAX_SAMPLE_RATE,
  MAX_SAMPLE_SECONDS,
  MAX_SPEECH_CHARS,
  MAX_SPEED,
  MIN_SAMPLE_RATE,
  MIN_SAMPLE_SECONDS,
  MIN_SPEED,
  nativeSpeech,
  SeparationError,
  SPEECH_LANGUAGES,
  type Speech,
  SpeechError,
  type SpeechLauncher,
  type SpeechRequest,
} from "./speech";
import { createStaticServer } from "./static";

const API = "/api/v1";
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

/** The client went away before the request finished. Nobody reads the response, so it is not an error. */
function cancelled(): ApiError {
  return new ApiError(499, "cancelled", "the request was cancelled");
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
  if (e instanceof SpeechError) {
    return json({ error: { code: "speech_error", message: e.message } }, 502);
  }
  console.error("[api] unexpected error:", e);
  return json({ error: { code: "internal_error", message: "internal server error" } }, 500);
}

interface TranslateRequest extends PromptInput {
  model: ModelSpec;
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
  // JSON Schema counts code points; String.length counts UTF-16 units, so only spread when that could matter.
  if (v.length > maxLength && [...v].length > maxLength)
    throw invalid(`${field} must be at most ${maxLength} characters`, field);
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

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"];

/** Lowercase host name from a Host-style value ("name:port", "[::1]:port"); undefined if malformed. */
function hostnameOf(hostport: string): string | undefined {
  try {
    return new URL(`http://${hostport}`).hostname.replace(/^\[(.*)\]$/, "$1");
  } catch {
    return undefined;
  }
}

/** Bare host from a config value, which has no port and may be bracketed IPv6. */
function bareHost(value: string): string {
  return value.replace(/^\[(.*)\]$/, "$1").toLowerCase();
}

/** Anti DNS-rebinding: a rebinding page reaches us under its own host name. */
function checkHost(req: Request, cfg: Config): void {
  const host = hostnameOf(req.headers.get("host") ?? "");
  const allowed = [...LOOPBACK_HOSTS, bareHost(cfg.host), ...cfg.allowedHosts.map(bareHost)];
  if (!host || !allowed.includes(host)) {
    throw new ApiError(403, "forbidden_host", "this Host header is not allowed; add the host name to ALLOWED_HOSTS");
  }
}

/** A request without an Origin header is not from a browser page and is allowed. */
function checkOrigin(req: Request, cfg: Config): void {
  const origin = req.headers.get("origin");
  if (origin === null) return;
  const host = (req.headers.get("host") ?? "").toLowerCase();
  let sameOrigin = false;
  try {
    sameOrigin = new URL(origin).host === host;
  } catch {
    // "null" and other non-URL origins are never same-origin
  }
  const allowed = cfg.allowedOrigins.some((o) => o.replace(/\/+$/, "").toLowerCase() === origin.toLowerCase());
  if (!sameOrigin && !allowed) {
    throw new ApiError(
      403,
      "forbidden_origin",
      "cross-origin requests are not allowed; add the origin to ALLOWED_ORIGINS",
    );
  }
}

/** Browsers send a cross-site form POST as text/plain without a preflight, so only JSON is accepted. */
function checkJsonContentType(req: Request): void {
  const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") {
    throw new ApiError(415, "unsupported_media_type", "request body must be application/json");
  }
}

async function parseBody(req: Request): Promise<Record<string, unknown>> {
  checkJsonContentType(req);
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

function parseTranslateRequest(req: Request, body: Record<string, unknown>, defaultModel: string): TranslateRequest {
  if (typeof body.text !== "string" || !body.text.trim()) throw invalid("text must be a non-empty string", "text");
  const targetLang = optionalString(body, "target_lang", 64);
  if (!targetLang?.trim()) throw invalid("target_lang must be a non-empty string", "target_lang");

  const modelId = optionalString(body, "model", 64) ?? defaultModel;
  const model = findModel(modelId);
  if (!model) {
    throw invalid(`unknown model "${modelId}"; see GET /api/v1/models`, "model");
  }

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

  const input: TranslateRequest = {
    text: body.text,
    model,
    targetLang,
    sourceLang: optionalString(body, "source_lang", 64),
    glossary: (glossary as Record<string, string> | null) ?? undefined,
    hardConstraints: optionalStringArray(body, "hard_constraints"),
    softConstraints: optionalStringArray(body, "soft_constraints"),
    genre: optionalString(body, "genre", 64),
    maxOutputTokens: (maxOutputTokens as number | null) ?? undefined,
    stream: body.stream === true || (req.headers.get("accept") ?? "").includes("text/event-stream"),
  };
  if (model.kind === "document") checkDocumentRequest(input);
  return input;
}

/** The document model takes a whole text in one of its fixed directions and nothing else. */
function checkDocumentRequest(input: TranslateRequest): void {
  const src = input.sourceLang?.trim().toLowerCase();
  if (!src || src === "auto") {
    throw invalid(`source_lang is required by ${input.model.id}`, "source_lang");
  }
  const tgt = input.targetLang.trim().toLowerCase();
  const direction = `${src}-${tgt}`;
  if (!DOCUMENT_DIRECTIONS.includes(direction)) {
    throw new ApiError(400, "unsupported_language_pair", `${input.model.id} does not translate ${src} to ${tgt}`, {
      field: "target_lang",
      supported: DOCUMENT_DIRECTIONS,
    });
  }
  const unsupported: [string, unknown][] = [
    ["glossary", input.glossary && Object.keys(input.glossary).length ? input.glossary : undefined],
    ["hard_constraints", input.hardConstraints?.length ? input.hardConstraints : undefined],
    ["soft_constraints", input.softConstraints?.length ? input.softConstraints : undefined],
    ["genre", input.genre],
  ];
  for (const [field, value] of unsupported) {
    if (value !== undefined) throw invalid(`${field} is not supported by ${input.model.id}`, field);
  }
}

/** Direction code of a document request, e.g. "zh-en". Only valid after checkDocumentRequest. */
function documentDirection(input: TranslateRequest): string {
  return `${input.sourceLang!.trim().toLowerCase()}-${input.targetLang.trim().toLowerCase()}`;
}

function promptFor(input: TranslateRequest): string {
  return input.model.kind === "document"
    ? buildDocumentPrompt(documentDirection(input), input.text)
    : buildPrompt(input);
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
  speech: Speech;
  stop(): Promise<void>;
}

export async function startApp(
  cfg: Config,
  launch: Launcher = launchNative,
  launchSpeech: SpeechLauncher = nativeSpeech,
): Promise<App> {
  const engine = new Engine(cfg, launch);
  const queue = new SlotQueue(cfg.maxQueue);
  const speech = launchSpeech(cfg);
  // Speech has its own line: it runs on its own thread and does not hold the translation engine.
  const speechQueue = new SlotQueue(cfg.maxQueue);
  const defaultModel = findModel(cfg.defaultModel)!;

  function enterQueue(onPosition?: (position: number) => void, line = queue): Ticket {
    try {
      return line.enter(onPosition);
    } catch (e) {
      if (e instanceof QueueFullError) {
        throw new ApiError(
          429,
          "queue_full",
          `too many ${line === queue ? "translations" : "speech requests"} are waiting; try again later`,
          {
            max_queue: cfg.maxQueue,
          },
          { "retry-after": "10" },
        );
      }
      throw e;
    }
  }

  /** Runs `fn` while holding the engine: no generation or model swap can overlap it. */
  async function underQueue<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    const ticket = enterQueue();
    const onAbort = () => ticket.leave();
    signal.addEventListener("abort", onAbort);
    try {
      if (!(await ticket.ready) || signal.aborted) throw cancelled();
      return await fn();
    } catch (e) {
      throw signal.aborted ? cancelled() : e;
    } finally {
      signal.removeEventListener("abort", onAbort);
      ticket.leave();
    }
  }

  // Load the default model before the first request arrives; requests that come earlier wait in line.
  void underQueue(new AbortController().signal, () => engine.load(defaultModel)).catch(() => {
    // already logged by the engine; the next request retries the load
  });

  function limits() {
    return { context_tokens: cfg.ctxSize, max_input_tokens: cfg.maxInputTokens };
  }

  async function prepare(input: TranslateRequest): Promise<Budget> {
    const prompt = promptFor(input);
    const promptTokens = await engine.countPromptTokens(prompt);
    if (promptTokens > cfg.maxInputTokens) {
      throw new ApiError(413, "input_too_long", "the input exceeds the token limit for a single translation", {
        prompt_tokens: promptTokens,
        max_input_tokens: cfg.maxInputTokens,
      });
    }
    const available = cfg.ctxSize - promptTokens - CONTEXT_MARGIN;
    // A non-positive budget would reach the engine as a limit <= 0, which it reads as unlimited.
    if (available < 1) {
      throw new ApiError(413, "input_too_long", "the input leaves no room for a translation in the context window", {
        prompt_tokens: promptTokens,
        context_tokens: cfg.ctxSize,
      });
    }
    // A translation is rarely several times longer than its source, while a model stuck in a
    // loop will fill whatever it is given; the default leaves room for the former only.
    const fallback = promptTokens * DEFAULT_OUTPUT_RATIO + DEFAULT_OUTPUT_FLOOR;
    return { prompt, promptTokens, maxOutputTokens: Math.min(input.maxOutputTokens ?? fallback, available) };
  }

  /** Waits for the queue slot, loads the requested model if needed, then generates. */
  async function* run(input: TranslateRequest, ticket: Ticket, signal: AbortSignal) {
    const queuedAt = performance.now();
    // Leaving while waiting settles ready as false; the caller then sees no result and reports cancellation.
    if (!(await ticket.ready) || signal.aborted) return;
    const queueMs = Math.round(performance.now() - queuedAt);

    await engine.load(input.model);
    const b = await prepare(input);
    yield {
      type: "start" as const,
      model: input.model.id,
      promptTokens: b.promptTokens,
      maxOutputTokens: b.maxOutputTokens,
      queueMs,
    };

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

  async function translateJson(input: TranslateRequest, signal: AbortSignal): Promise<Response> {
    const ticket = enterQueue();
    const onAbort = () => ticket.leave();
    signal.addEventListener("abort", onAbort);
    try {
      let translation = "";
      let result: Result | undefined;
      for await (const ev of run(input, ticket, signal)) {
        if (ev.type === "delta") translation += ev.text;
        else if (ev.type === "done") {
          result = {
            translation,
            finish_reason: ev.finish_reason,
            model: input.model.id,
            usage: ev.usage,
            timings: ev.timings,
          };
        }
      }
      if (!result) throw cancelled();
      return json(result);
    } catch (e) {
      // An aborted engine call throws a raw AbortError; for a gone client that is a cancellation, not a failure.
      throw signal.aborted ? cancelled() : e;
    } finally {
      signal.removeEventListener("abort", onAbort);
      ticket.leave();
    }
  }

  function translateSse(input: TranslateRequest, signal: AbortSignal): Response {
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
          for await (const ev of run(input, ticket, abort.signal)) {
            if (ev.type === "start") {
              send("start", {
                model: ev.model,
                prompt_tokens: ev.promptTokens,
                max_output_tokens: ev.maxOutputTokens,
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
            if (e instanceof ApiError) {
              send("error", { code: e.code, message: e.message, details: e.details });
            } else {
              const code = e instanceof EngineError ? "engine_error" : "internal_error";
              if (code === "internal_error") console.error("[api] stream failed:", e);
              send("error", { code, message: e instanceof EngineError ? e.message : "internal server error" });
            }
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

  const serveStatic = createStaticServer(cfg.publicDir);
  const devReload = cfg.devReload ? createDevReload(cfg.publicDir) : undefined;

  /**
   * Counts a request's prompt without entering the queue and without loading or swapping a model.
   * The prompt is built for the requested model's kind, but counted by the loaded engine's
   * tokenizer. This assumes the two 9B checkpoints share a tokenizer family; `counted_with` says
   * which model did the counting.
   */
  async function tokenize(input: TranslateRequest): Promise<Record<string, unknown>> {
    const unavailable = () =>
      new ApiError(
        503,
        "engine_unavailable",
        "the engine is loading or switching models; retry in a moment",
        undefined,
        { "retry-after": "2" },
      );
    const counter = engine.loaded;
    if (engine.state !== "ready" || !counter) throw unavailable();
    let promptTokens: number;
    try {
      promptTokens = await engine.countPromptTokens(promptFor(input));
    } catch (e) {
      // The model went away between the check above and the count (a swap freed it).
      if (e instanceof EngineError) throw unavailable();
      throw e;
    }
    return {
      model: input.model.id,
      counted_with: counter.id,
      prompt_tokens: promptTokens,
      fits: promptTokens <= cfg.maxInputTokens,
      max_output_tokens: Math.max(0, cfg.ctxSize - promptTokens - CONTEXT_MARGIN),
      limits: limits(),
    };
  }

  function speechUnavailable(message: string): ApiError {
    return new ApiError(503, "speech_unavailable", message);
  }

  async function parseSpeechRequest(body: Record<string, unknown>): Promise<SpeechRequest> {
    if (typeof body.text !== "string" || !body.text.trim()) throw invalid("text must be a non-empty string", "text");
    const text = optionalString(body, "text", MAX_SPEECH_CHARS)!;
    const lang = optionalString(body, "lang", 16)?.trim().toLowerCase();
    if (!lang || !SPEECH_LANGUAGES.includes(lang)) {
      throw new ApiError(400, "invalid_request", `lang must be one of ${SPEECH_LANGUAGES.join(", ")}`, {
        field: "lang",
        supported: SPEECH_LANGUAGES,
      });
    }
    const speed = body.speed ?? 1;
    if (typeof speed !== "number" || !(speed >= MIN_SPEED && speed <= MAX_SPEED)) {
      throw invalid(`speed must be a number from ${MIN_SPEED} to ${MAX_SPEED}`, "speed");
    }
    if (speech.state === "unavailable") throw speechUnavailable(speech.error ?? "reading aloud is not available");
    const voices = await speech.voices();
    if (voices.length === 0) {
      throw speechUnavailable(`no voices: upload a sample or put a WAV recording into ${cfg.voicesDir}`);
    }
    const voice = optionalString(body, "voice", 128) ?? voices[0]!.id;
    if (!voices.some((v) => v.id === voice)) {
      throw invalid(`unknown voice "${voice}"; see GET /api/v1/voices`, "voice");
    }
    return { text, lang, voice, speed };
  }

  async function uploadVoice(req: Request, url: URL): Promise<Response> {
    if (speech.state === "unavailable") throw speechUnavailable(speech.error ?? "reading aloud is not available");
    if ((req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase() !== "audio/wav") {
      throw new ApiError(415, "unsupported_media_type", "request body must be audio/wav");
    }
    const declared = Number(req.headers.get("content-length"));
    if (declared > MAX_SAMPLE_BYTES) throw new ApiError(413, "body_too_large", "the sample is too large");
    const wav = await req.arrayBuffer();
    if (wav.byteLength === 0) throw invalid("the body must be a WAV recording", "body");
    if (wav.byteLength > MAX_SAMPLE_BYTES) throw new ApiError(413, "body_too_large", "the sample is too large");
    const name = (url.searchParams.get("name") ?? "").replace(/\s+/g, " ").trim().slice(0, 60) || "Uploaded voice";
    try {
      return json(await speech.addVoice(name, wav), 201);
    } catch (e) {
      // Not the client's doing: the sample was fine, the engine could not separate it. Mapped by onError.
      if (e instanceof SpeechError && !(e instanceof SeparationError)) throw invalid(e.message, "body");
      throw e;
    }
  }

  async function speak(input: SpeechRequest, signal: AbortSignal): Promise<Response> {
    const ticket = enterQueue(undefined, speechQueue);
    // Aborted while waiting: leave the line. Once the utterance is handed to the engine the slot is
    // kept, because the engine cannot stop it; the engine's `done` gives it up, so abandoned
    // utterances count against the queue instead of piling up behind it.
    let handed = false;
    const onAbort = () => {
      if (!handed) ticket.leave();
    };
    signal.addEventListener("abort", onAbort);
    try {
      if (!(await ticket.ready) || signal.aborted) throw cancelled();
      handed = true;
      const wav = await speech.synthesize(input, signal, () => ticket.leave());
      return new Response(wav, { headers: { "content-type": "audio/wav", "cache-control": "no-store" } });
    } catch (e) {
      if (!handed) ticket.leave();
      throw signal.aborted ? cancelled() : e;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
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
      if (devReload && path.startsWith(DEV_PREFIX)) {
        const res = devReload.handle(path, req, server);
        if (res) return res;
      }
      if (!path.startsWith(API + "/")) {
        const res = await serveStatic(path, req);
        return devReload ? devReload.inject(res) : res;
      }

      try {
        checkHost(req, cfg);
        checkOrigin(req, cfg);
        switch (path.slice(API.length)) {
          case "/health": {
            if (req.method !== "GET") return methodNotAllowed("GET");
            return json(
              {
                status: engine.state,
                error: engine.error,
                model: engine.loaded?.id ?? null,
                limits: limits(),
                queue: { running: queue.running, waiting: queue.depth, max_waiting: cfg.maxQueue },
                speech: { status: speech.state, error: speech.error },
              },
              engine.state === "ready" ? 200 : 503,
            );
          }
          case "/models": {
            if (req.method !== "GET") return methodNotAllowed("GET");
            return json({
              default: defaultModel.id,
              loaded: engine.loaded?.id ?? null,
              models: MODELS.map((m) => ({
                id: m.id,
                label: m.label,
                kind: m.kind,
                ...(m.directions ? { directions: m.directions } : {}),
              })),
            });
          }
          case "/languages": {
            if (req.method !== "GET") return methodNotAllowed("GET");
            return json({ languages: LANGUAGES.map(({ code, name }) => ({ code, name })) });
          }
          case "/voices": {
            if (req.method === "POST") return await uploadVoice(req, url);
            if (req.method !== "GET") return methodNotAllowed("GET, POST");
            return json({
              status: speech.state,
              error: speech.error,
              languages: SPEECH_LANGUAGES,
              speed: { min: MIN_SPEED, max: MAX_SPEED },
              max_chars: MAX_SPEECH_CHARS,
              max_sample_bytes: MAX_SAMPLE_BYTES,
              sample_seconds: { min: MIN_SAMPLE_SECONDS, max: MAX_SAMPLE_SECONDS },
              sample_rate: { min: MIN_SAMPLE_RATE, max: MAX_SAMPLE_RATE },
              voices: speech.state === "unavailable" ? [] : await speech.voices(),
            });
          }
          case "/speech": {
            if (req.method !== "POST") return methodNotAllowed("POST");
            const input = await parseSpeechRequest(await parseBody(req));
            // The first request starts the engine and loads the model.
            server.timeout(req, 0);
            return await speak(input, req.signal);
          }
          case "/openapi.yaml": {
            if (req.method !== "GET") return methodNotAllowed("GET");
            return new Response(Bun.file(cfg.specPath), { headers: { "content-type": "application/yaml" } });
          }
          case "/tokenize": {
            if (req.method !== "POST") return methodNotAllowed("POST");
            const input = parseTranslateRequest(req, await parseBody(req), cfg.defaultModel);
            return json(await tokenize(input));
          }
          case "/translate": {
            if (req.method !== "POST") return methodNotAllowed("POST");
            const input = parseTranslateRequest(req, await parseBody(req), cfg.defaultModel);
            // A long translation can stay silent for minutes in JSON mode, and a model swap can take a while.
            server.timeout(req, 0);
            return input.stream ? translateSse(input, req.signal) : await translateJson(input, req.signal);
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
    speech,
    async stop() {
      devReload?.close();
      await server.stop(true);
      await speech.stop();
      await engine.unload();
    },
  };
}

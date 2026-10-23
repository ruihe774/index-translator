// Translating and counting on the chat engine: the prompt's token budget, the generation as events,
// and the cleaning of what the model says.

import type { TokenizeResponse, TranslateEvents, TranslateResponse } from "./api";
import { type Config, CONTEXT_MARGIN } from "./config";
import { ApiError, cancelled, json } from "./http";
import { type Engine, EngineError } from "./llama";
import { promptFor, type TranslateRequest } from "./parse";
import type { Ticket } from "./queue";
import { type Line, withTicket } from "./tickets";

const DEFAULT_OUTPUT_RATIO = 4;
const DEFAULT_OUTPUT_FLOOR = 512;

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
        if (end === -1) {
          return "";
        }
        this.head = this.head.slice(end + THINK_CLOSE.length).trimStart();
      }
      if (!this.head || THINK_OPEN.startsWith(this.head)) {
        return "";
      }
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
    if (this.inBody || this.head.startsWith(THINK_OPEN)) {
      return "";
    }
    this.inBody = true;
    return this.head.trimEnd();
  }
}

/** What a generation yields: the budget it starts with, the text as it comes, how it ended. */
export type RunEvent =
  | { type: "start"; model: string; promptTokens: number; maxOutputTokens: number; queueMs: number }
  | { type: "delta"; text: string }
  | ({ type: "done" } & TranslateEvents["done"]);

export function limits(cfg: Config) {
  return { context_tokens: cfg.ctxSize, max_input_tokens: cfg.maxInputTokens };
}

/** What a prompt of `promptTokens` leaves of the context window for the translation. */
function budget(cfg: Config, promptTokens: number): number {
  return Math.max(0, cfg.ctxSize - promptTokens - CONTEXT_MARGIN);
}

export function createTranslator(cfg: Config, engine: Engine, line: Line) {
  async function prepare(input: TranslateRequest) {
    const prompt = promptFor(input);
    const promptTokens = await engine.countPromptTokens(prompt, input.image);
    if (promptTokens > cfg.maxInputTokens) {
      throw new ApiError(413, "input_too_long", "the input exceeds the token limit for a single translation", {
        prompt_tokens: promptTokens,
        max_input_tokens: cfg.maxInputTokens,
      });
    }
    const available = budget(cfg, promptTokens);
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
  async function* run(input: TranslateRequest, ticket: Ticket, signal: AbortSignal): AsyncGenerator<RunEvent> {
    const queuedAt = performance.now();
    // Leaving while waiting settles ready as false; the caller then sees no result and reports cancellation.
    if (!(await ticket.ready) || signal.aborted) {
      return;
    }
    const queueMs = Math.round(performance.now() - queuedAt);

    await engine.load(input.model);
    const b = await prepare(input);
    yield {
      type: "start",
      model: input.model.id,
      promptTokens: b.promptTokens,
      maxOutputTokens: b.maxOutputTokens,
      queueMs,
    };

    const cleaner = new OutputCleaner();
    for await (const ev of engine.generate(b.prompt, b.maxOutputTokens, signal, input.image)) {
      if (ev.type === "delta") {
        const text = cleaner.push(ev.text);
        if (text) {
          yield { type: "delta", text };
        }
      } else {
        const rest = cleaner.flush();
        if (rest) {
          yield { type: "delta", text: rest };
        }
        yield {
          type: "done",
          finish_reason: ev.finishReason,
          usage: ev.usage.prompt_tokens ? ev.usage : { ...ev.usage, prompt_tokens: b.promptTokens },
          timings: { queue_ms: queueMs, ...ev.timings },
        };
      }
    }
  }

  async function translateJson(input: TranslateRequest, signal: AbortSignal): Promise<Response> {
    // `run` waits for the slot itself, to say how long it took.
    return withTicket(
      line,
      signal,
      async ({ ticket }) => {
        let translation = "";
        let result: TranslateResponse | undefined;
        for await (const ev of run(input, ticket, signal)) {
          if (ev.type === "delta") {
            translation += ev.text;
          } else if (ev.type === "done") {
            result = {
              translation,
              finish_reason: ev.finish_reason,
              model: input.model.id,
              usage: ev.usage,
              timings: ev.timings,
            };
          }
        }
        if (!result) {
          throw cancelled();
        }
        return json<TranslateResponse>(result);
      },
      false,
    );
  }

  /**
   * Counts a request's prompt without entering the queue and without loading or swapping a model.
   * The prompt is built for the requested model's kind, but counted by the loaded engine's
   * tokenizer. This assumes the two 9B checkpoints share a tokenizer family; `counted_with` says
   * which model did the counting.
   */
  async function tokenize(input: TranslateRequest): Promise<TokenizeResponse> {
    const unavailable = () =>
      new ApiError(
        503,
        "engine_unavailable",
        "the engine is loading or switching models; retry in a moment",
        undefined,
        { "retry-after": "2" },
      );
    const counter = engine.loaded;
    if (engine.state !== "ready" || !counter) {
      throw unavailable();
    }
    let promptTokens: number;
    try {
      promptTokens = await engine.countPromptTokens(promptFor(input));
    } catch (e) {
      // The model went away between the check above and the count (a swap freed it).
      if (e instanceof EngineError) {
        throw unavailable();
      }
      throw e;
    }
    return {
      model: input.model.id,
      counted_with: counter.id,
      prompt_tokens: promptTokens,
      fits: promptTokens <= cfg.maxInputTokens,
      available_output_tokens: budget(cfg, promptTokens),
      limits: limits(cfg),
    };
  }

  return { run, translateJson, tokenize };
}

// Worker thread that owns libllama. FFI calls block, so they run here and the server thread stays
// free to answer requests. Loads, unloads and generations run one after another; a generation
// returns to the event loop after every decode, which is when token counts are answered and
// cancellations are seen.

import type { EngineTimings, FinishReason, Usage } from "./llama";
import { Model, type ModelOptions } from "./llama-ffi";

export type WorkerRequest =
  | { type: "load"; req: number; model: number; options: ModelOptions }
  | { type: "unload"; req: number; model: number }
  | { type: "count"; req: number; model: number; content: string }
  | { type: "generate"; req: number; model: number; content: string; maxTokens: number }
  | { type: "cancel"; req: number };

export type WorkerReply =
  | { type: "ok"; req: number }
  | { type: "count"; req: number; tokens: number }
  | { type: "delta"; req: number; text: string }
  | { type: "done"; req: number; finishReason: FinishReason; usage: Usage; timings: EngineTimings }
  | { type: "error"; req: number; message: string };

// eslint-disable-next-line no-var -- only `var` declares a global
declare var self: Worker;

const post = (reply: WorkerReply) => self.postMessage(reply);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

let model: Model | undefined;
/** The main thread's number for `model`; requests for any other one are stale. */
let modelNo = 0;
/** Bumped by every load and unload, so a running generation knows to give up its model. */
let epoch = 0;
/** Loads, unloads and generations, in arrival order. */
let chain: Promise<void> = Promise.resolve();
/** Generations that are queued or running, and the ones among them whose client has gone. */
const active = new Set<number>();
const cancelled = new Set<number>();

function exclusive(req: number, fn: () => void | Promise<void>): void {
  chain = chain.then(fn).catch((e) => post({ type: "error", req, message: messageOf(e) }));
}

function unload(): void {
  model?.free();
  model = undefined;
  modelNo = 0;
}

async function generate(m: Model, started: number, req: number, content: string, maxTokens: number): Promise<void> {
  // True once the client is gone or the model is about to be replaced.
  const stopped = () => cancelled.has(req) || epoch !== started;

  const tokens = m.tokenize(content);
  const room = m.ctxSize - tokens.length;
  if (room < 1) throw new Error(`the prompt (${tokens.length} tokens) does not fit the ${m.ctxSize}-token context`);
  const limit = maxTokens > 0 ? Math.min(maxTokens, room) : room;

  m.reset();
  const promptStart = performance.now();
  for (let i = 0; i < tokens.length && !stopped(); i += m.promptStep) {
    m.decode(tokens.subarray(i, i + m.promptStep));
    await tick();
  }

  const generationStart = performance.now();
  // Holds back the bytes of a character until its last token arrives.
  const utf8 = new TextDecoder();
  let produced = 0;
  let finishReason: FinishReason = "length";
  while (!stopped()) {
    const token = m.sample();
    produced++;
    if (m.isEnd(token)) {
      finishReason = "stop";
      break;
    }
    const text = utf8.decode(m.piece(token), { stream: true });
    if (text) post({ type: "delta", req, text });
    if (produced >= limit) break;
    m.decodeOne(token);
    await tick();
  }
  if (cancelled.has(req)) return;
  if (epoch !== started) throw new Error("the model was unloaded during the generation");

  const generationMs = performance.now() - generationStart;
  post({
    type: "done",
    req,
    finishReason,
    usage: { prompt_tokens: tokens.length, completion_tokens: produced },
    timings: {
      prompt_ms: Math.round(generationStart - promptStart),
      generation_ms: Math.round(generationMs),
      tokens_per_second: generationMs > 0 ? Number(((produced * 1000) / generationMs).toFixed(2)) : 0,
    },
  });
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  switch (msg.type) {
    case "load":
      epoch++;
      exclusive(msg.req, () => {
        unload();
        model = Model.load(msg.options);
        modelNo = msg.model;
        post({ type: "ok", req: msg.req });
      });
      break;
    case "unload":
      if (msg.model === modelNo) epoch++;
      exclusive(msg.req, () => {
        if (msg.model === modelNo) unload();
        post({ type: "ok", req: msg.req });
      });
      break;
    case "count":
      try {
        if (!model || msg.model !== modelNo) throw new Error("the model is not loaded");
        post({ type: "count", req: msg.req, tokens: model.tokenize(msg.content).length });
      } catch (e) {
        post({ type: "error", req: msg.req, message: messageOf(e) });
      }
      break;
    case "generate": {
      const started = epoch;
      active.add(msg.req);
      exclusive(msg.req, async () => {
        try {
          if (cancelled.has(msg.req)) return;
          if (!model || msg.model !== modelNo || epoch !== started) throw new Error("the model is not loaded");
          await generate(model, started, msg.req, msg.content, msg.maxTokens);
        } finally {
          active.delete(msg.req);
          cancelled.delete(msg.req);
        }
      });
      break;
    }
    case "cancel":
      if (active.has(msg.req)) cancelled.add(msg.req);
      break;
  }
};

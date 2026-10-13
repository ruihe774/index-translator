// Worker thread that owns libllama. FFI calls block, so they run here and the server thread stays
// free to answer requests. Loads, unloads and generations run one after another; a generation
// returns to the event loop after every decode, which is when token counts are answered and
// cancellations are seen.

import type { EngineTimings, FinishReason, Usage } from "./llama";
import { ImageError, Model } from "./llama-ffi";
import type { ImagePrompt, ModelOptions } from "./llama-ffi";

export type WorkerRequest =
  | { type: "load"; req: number; model: number; options: ModelOptions }
  | { type: "unload"; req: number; model: number }
  // `image`: a PNG file that follows the content in the user message.
  | { type: "count"; req: number; model: number; content: string; image?: Uint8Array }
  | { type: "generate"; req: number; model: number; content: string; maxTokens: number; image?: Uint8Array }
  | { type: "cancel"; req: number };

export type WorkerReply =
  | { type: "ok"; req: number }
  | { type: "count"; req: number; tokens: number }
  | { type: "delta"; req: number; text: string }
  | { type: "done"; req: number; finishReason: FinishReason; usage: Usage; timings: EngineTimings }
  // `image`: the image itself is at fault, not the engine.
  | { type: "error"; req: number; message: string; image?: boolean };

// eslint-disable-next-line no-var, vars-on-top -- only `var` declares a global
declare var self: Worker;

// eslint-disable-next-line unicorn/require-post-message-target-origin -- Worker.postMessage has no target origin
const post = (reply: WorkerReply) => self.postMessage(reply);
const tick = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
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

const postError = (req: number, e: unknown) =>
  post({ type: "error", req, message: messageOf(e), ...(e instanceof ImageError ? { image: true } : {}) });

function exclusive(req: number, fn: () => void | Promise<void>): void {
  chain = chain.then(fn).catch((error) => postError(req, error));
}

function unload(): void {
  model?.free();
  model = undefined;
  modelNo = 0;
}

/**
 * Evaluates a prompt with an image on the emptied context, piece by piece; the image's piece (its
 * encoding and the decoding of its embeddings) cannot be stopped midway.
 */
async function evalImagePrompt(m: Model, prompt: ImagePrompt, stopped: () => boolean): Promise<void> {
  for (let i = 0; i < prompt.chunks && !stopped(); i++) {
    m.evalChunk(prompt, i);
    await tick();
  }
}

async function generate(
  m: Model,
  started: number,
  req: number,
  content: string,
  maxTokens: number,
  image?: Uint8Array,
): Promise<void> {
  // True once the client is gone or the model is about to be replaced.
  const stopped = () => cancelled.has(req) || epoch !== started;

  const tokens = image ? undefined : m.tokenize(content);
  const imagePrompt = image ? m.imagePrompt(content, image) : undefined;
  const promptTokens = imagePrompt?.tokens ?? tokens!.length;
  const room = m.ctxSize - promptTokens;
  if (room < 1) {
    imagePrompt?.free();
    throw new Error(`the prompt (${promptTokens} tokens) does not fit the ${m.ctxSize}-token context`);
  }
  const limit = maxTokens > 0 ? Math.min(maxTokens, room) : room;

  m.reset();
  const promptStart = performance.now();
  if (imagePrompt) {
    try {
      await evalImagePrompt(m, imagePrompt, stopped);
    } finally {
      imagePrompt.free();
    }
  } else {
    for (let i = 0; i < tokens!.length && !stopped(); i += m.promptStep) {
      m.decode(tokens!.subarray(i, i + m.promptStep));
      await tick();
    }
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
    if (text) {
      post({ type: "delta", req, text });
    }
    if (produced >= limit) {
      break;
    }
    m.decodeOne(token);
    await tick();
  }
  if (cancelled.has(req)) {
    return;
  }
  if (epoch !== started) {
    throw new Error("the model was unloaded during the generation");
  }

  const generationMs = performance.now() - generationStart;
  post({
    type: "done",
    req,
    finishReason,
    usage: { prompt_tokens: promptTokens, completion_tokens: produced },
    timings: {
      prompt_ms: Math.round(generationStart - promptStart),
      generation_ms: Math.round(generationMs),
      tokens_per_second: generationMs > 0 ? Number(((produced * 1000) / generationMs).toFixed(2)) : 0,
    },
  });
}

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  switch (msg.type) {
    case "load": {
      epoch++;
      exclusive(msg.req, () => {
        unload();
        model = Model.load(msg.options);
        modelNo = msg.model;
        post({ type: "ok", req: msg.req });
      });
      break;
    }
    case "unload": {
      if (msg.model === modelNo) {
        epoch++;
      }
      exclusive(msg.req, () => {
        if (msg.model === modelNo) {
          unload();
        }
        post({ type: "ok", req: msg.req });
      });
      break;
    }
    case "count": {
      const { image } = msg;
      if (image) {
        // Counting an image means decoding and scaling it, and the first one loads the encoder: that
        // waits its turn like a generation, which the caller has the queue slot for anyway.
        exclusive(msg.req, () => {
          if (!model || msg.model !== modelNo) {
            throw new Error("the model is not loaded");
          }
          const prompt = model.imagePrompt(msg.content, image);
          const { tokens } = prompt;
          prompt.free();
          post({ type: "count", req: msg.req, tokens });
        });
        break;
      }
      try {
        if (!model || msg.model !== modelNo) {
          throw new Error("the model is not loaded");
        }
        post({ type: "count", req: msg.req, tokens: model.tokenize(msg.content).length });
      } catch (error) {
        postError(msg.req, error);
      }
      break;
    }
    case "generate": {
      const started = epoch;
      active.add(msg.req);
      exclusive(msg.req, async () => {
        try {
          if (cancelled.has(msg.req)) {
            return;
          }
          if (!model || msg.model !== modelNo || epoch !== started) {
            throw new Error("the model is not loaded");
          }
          await generate(model, started, msg.req, msg.content, msg.maxTokens, msg.image);
        } finally {
          active.delete(msg.req);
          cancelled.delete(msg.req);
        }
      });
      break;
    }
    case "cancel": {
      if (active.has(msg.req)) {
        cancelled.add(msg.req);
      }
      break;
    }
  }
});

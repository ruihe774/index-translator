// Worker thread that owns libllama. FFI calls block, so they run here and the server thread stays
// free to answer requests. Loads, unloads and generations run one after another; a generation
// returns to the event loop after every decode, which is when token counts are answered and
// cancellations are seen.

import type { EngineTimings, FinishReason, Usage } from "./llama";
import { type GpuMemory, gpuMemory, ImageError, type ImagePrompt, Model, type ModelOptions } from "./llama-ffi";
import { type NoBody, serve } from "./worker-rpc";

// `image`: a PNG file that follows the content in the user message.
export interface LlamaProtocol {
  load: { request: { model: number; options: ModelOptions }; reply: { type: "ok" } };
  // Answered between decodes, like `count`; waits for a load in progress.
  memory: { request: NoBody; reply: { type: "memory"; memory?: GpuMemory } };
  unload: { request: { model: number }; reply: { type: "ok" } };
  count: { request: { model: number; content: string; image?: Uint8Array }; reply: { type: "count"; tokens: number } };
  generate: {
    request: { model: number; content: string; maxTokens: number; image?: Uint8Array };
    stream: { type: "delta"; text: string };
    reply: { type: "done"; finishReason: FinishReason; usage: Usage; timings: EngineTimings };
  };
  // `target`: the `req` of the generation to give up; never answered.
  cancel: { request: { target: number }; reply: never };
}

const tick = () => new Promise<void>((resolve) => void setImmediate(resolve));

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

/** Runs `fn` after everything before it; a failure answers its own request and not the ones behind it. */
function exclusive<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = chain.then(fn);
  chain = run.then(
    () => {},
    () => {},
  );
  return run;
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
  image: Uint8Array | undefined,
  post: (delta: { type: "delta"; text: string }) => void,
): Promise<LlamaProtocol["generate"]["reply"] | undefined> {
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
  // Tokens chosen and not sent yet; the last of them is not decoded yet. With multi-token prediction one
  // decode may choose several.
  let chosen: Int32Array = Int32Array.of(m.sample());
  let sent = 0;
  while (!stopped()) {
    const token = chosen[sent++]!;
    produced++;
    if (m.isEnd(token)) {
      finishReason = "stop";
      break;
    }
    const text = utf8.decode(m.piece(token), { stream: true });
    if (text) {
      post({ type: "delta", text });
    }
    if (produced >= limit) {
      break;
    }
    if (sent === chosen.length) {
      chosen = m.next(token, limit - produced);
      sent = 0;
      await tick();
    }
  }
  if (cancelled.has(req)) {
    return;
  }
  if (epoch !== started) {
    throw new Error("the model was unloaded during the generation");
  }

  const generationMs = performance.now() - generationStart;
  return {
    type: "done",
    finishReason,
    usage: { prompt_tokens: promptTokens, completion_tokens: produced },
    timings: {
      prompt_ms: Math.round(generationStart - promptStart),
      generation_ms: Math.round(generationMs),
      tokens_per_second: generationMs > 0 ? Number(((produced * 1000) / generationMs).toFixed(2)) : 0,
    },
  };
}

/** The model a request names, or the error that it is not loaded (replaced, or freed meanwhile). */
function loadedModel(no: number): Model {
  if (!model || no !== modelNo) {
    throw new Error("the model is not loaded");
  }
  return model;
}

serve<LlamaProtocol>(
  {
    load: (msg) => {
      epoch++;
      return exclusive(() => {
        unload();
        model = Model.load(msg.options);
        modelNo = msg.model;
        return { type: "ok" };
      });
    },
    unload: (msg) => {
      if (msg.model === modelNo) {
        epoch++;
      }
      return exclusive(() => {
        if (msg.model === modelNo) {
          unload();
        }
        return { type: "ok" };
      });
    },
    memory: () => ({ type: "memory", memory: gpuMemory() }),
    count: (msg) => {
      const { image } = msg;
      if (!image) {
        return { type: "count", tokens: loadedModel(msg.model).tokenize(msg.content).length };
      }
      // Counting an image means decoding and scaling it, and the first one loads the encoder: that
      // waits its turn like a generation, which the caller has the queue slot for anyway.
      return exclusive(() => {
        const prompt = loadedModel(msg.model).imagePrompt(msg.content, image);
        const { tokens } = prompt;
        prompt.free();
        return { type: "count", tokens };
      });
    },
    generate: (msg, post) => {
      const started = epoch;
      active.add(msg.req);
      return exclusive(async () => {
        try {
          if (cancelled.has(msg.req)) {
            return;
          }
          if (epoch !== started) {
            throw new Error("the model is not loaded");
          }
          return await generate(loadedModel(msg.model), started, msg.req, msg.content, msg.maxTokens, msg.image, post);
        } finally {
          active.delete(msg.req);
          cancelled.delete(msg.req);
        }
      });
    },
    cancel: (msg) => {
      if (active.has(msg.target)) {
        cancelled.add(msg.target);
      }
    },
  },
  (e) => (e instanceof ImageError ? { image: true } : {}),
);

// The worker that decodes the speech stream's QOA audio with qoa-wasm (public/vendor/qoa, see
// scripts/fetch_web_libs.ts). A worker so that the page's script policy needs no `wasm-unsafe-eval`
// (a worker script carries no policy of its own, as with pdf-worker.ts), and the decoding stays off
// the page's thread.
//
// Messages in: `{ type: "open", id }`, then `{ type: "chunk", id, bytes }` as the response arrives
// and `{ type: "end", id }`; `{ type: "cancel", id }` drops a stream. Chunks may end anywhere: whole
// frames are decoded as soon as they are complete. Out: `{ type: "ready" }` once, or
// `{ type: "unavailable", message }` when the codec cannot run here; then per stream
// `{ type: "audio", id, sampleRate, channels, samples }` or `{ type: "error", id, message }`.

import type { Pcm16 } from "./speech-audio.ts";

export type QoaRequest =
  | { type: "open"; id: number }
  | { type: "chunk"; id: number; bytes: Uint8Array }
  | { type: "end"; id: number }
  | { type: "cancel"; id: number };

export type QoaReply =
  | { type: "ready" }
  | { type: "unavailable"; message: string }
  | ({ type: "audio"; id: number } & Pcm16)
  | { type: "error"; id: number; message: string };

/** The part of qoa-wasm's `Qoa` that is used (its `src/qoa.ts`). */
interface Codec {
  decode(data: Uint8Array): Pcm16;
}

const FILE_HEADER = 8;
const FRAME_HEADER = 8;

interface Stream {
  /** The file header as sent (a stream: its sample count is 0); put in front of the frames of each decode. */
  header: Uint8Array | undefined;
  /** Bytes received that do not make a whole frame yet. */
  pending: Uint8Array;
  parts: Int16Array[];
  format: { sampleRate: number; channels: number } | undefined;
}

const DIR = "/vendor/qoa";

let codec: Codec | undefined;
const streams = new Map<number, Stream>();

function join<T extends Uint8Array | Int16Array>(parts: T[]): T {
  const length = parts.reduce((n, p) => n + p.length, 0);
  const out = new (parts[0]!.constructor as new (n: number) => T)(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Decodes the frames of `stream` that are complete. Throws on anything that is not QOA. */
function decodeWhole(stream: Stream): void {
  if (!stream.header) {
    if (stream.pending.length < FILE_HEADER) {
      return;
    }
    stream.header = stream.pending.slice(0, FILE_HEADER);
    stream.pending = stream.pending.slice(FILE_HEADER);
  }
  let end = 0;
  while (stream.pending.length - end >= FRAME_HEADER) {
    const size = (stream.pending[end + 6]! << 8) | stream.pending[end + 7]!;
    if (size < FRAME_HEADER) {
      throw new Error("invalid frame header");
    }
    if (end + size > stream.pending.length) {
      break;
    }
    end += size;
  }
  if (end === 0) {
    return;
  }
  const audio = codec!.decode(join([stream.header, stream.pending.subarray(0, end)]));
  stream.format ??= { sampleRate: audio.sampleRate, channels: audio.channels };
  if (audio.sampleRate !== stream.format.sampleRate || audio.channels !== stream.format.channels) {
    throw new Error("the format changes inside the stream");
  }
  stream.parts.push(audio.samples);
  stream.pending = stream.pending.slice(end);
}

function handle(request: QoaRequest): QoaReply | undefined {
  const { id } = request;
  if (request.type === "open") {
    streams.set(id, { header: undefined, pending: new Uint8Array(0), parts: [], format: undefined });
    return undefined;
  }
  if (request.type === "cancel") {
    streams.delete(id);
    return undefined;
  }
  const stream = streams.get(id);
  // Cancelled or failed: what still arrives for it is dropped.
  if (!stream) {
    return undefined;
  }
  try {
    if (request.type === "chunk") {
      stream.pending = stream.pending.length === 0 ? request.bytes : join([stream.pending, request.bytes]);
      decodeWhole(stream);
      return undefined;
    }
    streams.delete(id);
    if (!stream.format || stream.pending.length > 0) {
      throw new Error("the stream ended inside a frame or had none");
    }
    return { type: "audio", id, ...stream.format, samples: join(stream.parts) };
  } catch (error) {
    streams.delete(id);
    return { type: "error", id, message: error instanceof Error ? error.message : String(error) };
  }
}

async function start(): Promise<void> {
  try {
    const loaded = (await import(`${DIR}/qoa.ts`)) as { Qoa: { create(): Promise<Codec> } };
    codec = await loaded.Qoa.create();
    // eslint-disable-next-line unicorn/require-post-message-target-origin -- a dedicated worker answers its page; there is no origin to name
    self.postMessage({ type: "ready" } satisfies QoaReply);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line unicorn/require-post-message-target-origin -- a dedicated worker answers its page; there is no origin to name
    self.postMessage({ type: "unavailable", message } satisfies QoaReply);
  }
}

// eslint-disable-next-line unicorn/prefer-top-level-await -- the message handler below must be registered before the codec loads
const started = start();
// In arrival order, after the codec is there.
let last: Promise<void> = started;
self.addEventListener("message", (event: MessageEvent<QoaRequest>) => {
  last = last.then(() => {
    if (codec) {
      const reply = handle(event.data);
      if (reply?.type === "audio") {
        self.postMessage(reply, { transfer: [reply.samples.buffer] });
      } else if (reply) {
        // eslint-disable-next-line unicorn/require-post-message-target-origin -- a dedicated worker answers its page; there is no origin to name
        self.postMessage(reply);
      }
    }
    return undefined;
  });
});

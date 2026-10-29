// The page's side of the QOA speech stream: starts the decoding worker (qoa-worker.ts), says
// whether QOA can be used at all, and decodes a response body while it arrives. QOA is the default
// way speech reaches the page; WAV is what is left when the browser has no WebAssembly or no
// module workers, the codec files are not on the server (a checkout where
// scripts/fetch_web_libs.ts was not run), the worker fails, or the codec stops working halfway.
//
// Nothing here talks to the API: speech-ui.ts asks, this decodes the body it gets.

import type { QoaReply, QoaRequest } from "./qoa-worker.ts";
import type { Pcm16 } from "./speech-audio.ts";
import { workerClient } from "./worker-client.ts";

export const QOA_TYPE = "audio/qoa";

/** The decoder failed on this stream or is gone; the caller can ask for WAV instead. */
export class QoaError extends Error {
  override name = "QoaError";
}

export interface QoaDecoder {
  /** Decodes the whole of `body` as it arrives; the worker works on each chunk when it comes. */
  decode(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<Pcm16>;
}

/** A worker that is ready, or null when this browser cannot run the codec. */
function startDecoder(): Promise<QoaDecoder | null> {
  // Both are in every browser the page supports except an engine with WebAssembly turned off.
  if (typeof WebAssembly !== "object" || typeof Worker !== "function") {
    return Promise.resolve(null);
  }
  return new Promise((ready) => {
    let worker: Worker;
    try {
      worker = new Worker("/qoa-worker.ts", { type: "module" });
    } catch {
      ready(null);
      return;
    }
    const client = workerClient<Pcm16>();
    const fail = (e: QoaError) => {
      worker.terminate();
      client.fail(e);
    };

    worker.addEventListener("message", (event: MessageEvent<QoaReply>) => {
      const reply = event.data;
      if (reply.type === "ready") {
        ready(decoder);
      } else if (reply.type === "unavailable") {
        console.info(`QOA speech is off, using WAV: ${reply.message}`);
        fail(new QoaError(reply.message));
        ready(null);
      } else {
        const w = client.take(reply.id);
        if (reply.type === "error") {
          w?.reject(new QoaError(reply.message));
        } else {
          w?.resolve({ sampleRate: reply.sampleRate, channels: reply.channels, samples: reply.samples });
        }
      }
    });
    // The worker's script did not load (a codec that is not installed ends here too).
    worker.addEventListener("error", () => {
      fail(new QoaError("the QOA decoder did not start"));
      ready(null);
    });

    const post = (request: QoaRequest, transfer: Transferable[] = []) => worker.postMessage(request, transfer);
    const decoder: QoaDecoder = {
      async decode(body, signal) {
        if (client.dead) {
          throw client.dead;
        }
        const reader = body.getReader();
        let id = -1;
        const result = client.request((n) => void (id = n));
        // Settled by the worker, or by the abort below; checked between chunks to stop reading early.
        let settled = false;
        result.then(
          () => void (settled = true),
          () => void (settled = true),
        );
        const abort = () => {
          client.take(id)?.reject(signal.reason);
          post({ type: "cancel", id });
          void reader.cancel().catch(() => {});
        };
        if (signal.aborted) {
          abort();
          return result;
        }
        signal.addEventListener("abort", abort, { once: true });
        post({ type: "open", id });
        try {
          // eslint-disable-next-line no-unmodified-loop-condition -- modified in promises
          while (!settled) {
            const { done, value } = await reader.read();
            if (settled) {
              break;
            }
            if (done) {
              post({ type: "end", id });
              break;
            }
            // Handed over: the worker keeps the bytes (a copy when the chunk is a view into a larger buffer).
            const bytes =
              value.byteOffset === 0 && value.byteLength === value.buffer.byteLength ? value : value.slice();
            post({ type: "chunk", id, bytes }, [bytes.buffer]);
          }
          return await result;
        } catch (e) {
          // The body broke off, or the worker gave up on it: the worker forgets the stream, and so does the table.
          client.take(id);
          post({ type: "cancel", id });
          throw e;
        } finally {
          signal.removeEventListener("abort", abort);
          void reader.cancel().catch(() => {});
        }
      },
    };
  });
}

let decoder: Promise<QoaDecoder | null> | undefined;

/** The decoder, started on the first call; null when QOA cannot be used here. The answer is kept. */
export function qoaDecoder(): Promise<QoaDecoder | null> {
  decoder ??= startDecoder();
  return decoder;
}

/** After a stream failed for a reason of the codec, not of the network: from now on WAV only. */
export function giveUpQoa(): void {
  decoder = Promise.resolve(null);
}

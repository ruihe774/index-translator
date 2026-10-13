// Worker thread that owns libaudiocpp. FFI calls block, so they run here and the server thread
// stays free to answer requests. Every message is handled to its end before the next one: loads,
// unloads and utterances run in arrival order. While this thread is inside the library it reads no
// messages, so an utterance is stopped through memory it shares with the server thread instead.

import { readFileSync } from "node:fs";
import { AbortedError, SpeechModel, type SpeechModelOptions, VoiceSeparator } from "./audiocpp-ffi";
import { normalizeLoudness, readWav, resample, writeWav } from "./wav";

export type SpeechWorkerRequest =
  | { type: "load"; req: number; options: SpeechModelOptions }
  | { type: "unload"; req: number }
  // `abort` holds one Int32: the server thread makes it non-zero when nobody wants the utterance
  // any more, and the library gives up at its next step (or the utterance is not started at all).
  | {
      type: "synthesize";
      req: number;
      text: string;
      lang: string;
      voicePath: string;
      speed: number;
      abort: SharedArrayBuffer;
    }
  // Frees the speech model, loads the separation model, takes the vocals out of the WAV recording,
  // and frees the separation model again. The speech model is not loaded afterwards.
  | { type: "separate"; req: number; options: SpeechModelOptions; wav: ArrayBuffer };

export type SpeechWorkerReply =
  | { type: "ok"; req: number }
  | { type: "audio"; req: number; wav: ArrayBuffer }
  /** The utterance was given up because its `abort` was set. */
  | { type: "aborted"; req: number }
  | { type: "error"; req: number; message: string };

declare var self: Worker;

/** Sampling is seeded so the same sentence sounds the same when it is played again. */
const SEED = 42;
/** The only sample rate BS-RoFormer accepts. */
const SEPARATOR_RATE = 44100;

let model: SpeechModel | undefined;

function handle(msg: SpeechWorkerRequest): SpeechWorkerReply {
  switch (msg.type) {
    case "load":
      model?.free();
      model = undefined;
      model = SpeechModel.load(msg.options);
      return { type: "ok", req: msg.req };
    case "unload":
      model?.free();
      model = undefined;
      return { type: "ok", req: msg.req };
    case "synthesize": {
      if (!model) throw new Error("the speech model is not loaded");
      const abort = new Int32Array(msg.abort);
      // Given up while it waited behind another message.
      if (Atomics.load(abort, 0) !== 0) return { type: "aborted", req: msg.req };
      const voice = readWav(readFileSync(msg.voicePath));
      try {
        // The model's duration control: 2 doubles the duration, so it is the inverse of the speed.
        const pcm = model.synthesize(
          msg.text,
          msg.lang,
          voice,
          { duration_factor: String(1 / msg.speed), seed: String(SEED) },
          abort,
        );
        return { type: "audio", req: msg.req, wav: writeWav(pcm) };
      } catch (e) {
        if (e instanceof AbortedError) return { type: "aborted", req: msg.req };
        throw e;
      }
    }
    case "separate": {
      // Only one of the two models is on the GPU at a time.
      model?.free();
      model = undefined;
      // The separation model takes 44.1 kHz, mono or stereo, and nothing else.
      const mixture = resample(readWav(new Uint8Array(msg.wav)), SEPARATOR_RATE, 2);
      const separator = VoiceSeparator.load(msg.options);
      try {
        return { type: "audio", req: msg.req, wav: writeWav(normalizeLoudness(separator.vocals(mixture))) };
      } finally {
        separator.free();
      }
    }
  }
}

self.onmessage = (event: MessageEvent<SpeechWorkerRequest>) => {
  let reply: SpeechWorkerReply;
  try {
    reply = handle(event.data);
  } catch (e) {
    reply = { type: "error", req: event.data.req, message: e instanceof Error ? e.message : String(e) };
  }
  self.postMessage(reply, reply.type === "audio" ? [reply.wav] : []);
};

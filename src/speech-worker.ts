// Worker thread that owns libaudiocpp. FFI calls block, so they run here and the server thread
// stays free to answer requests. Every message is handled to its end before the next one: loads,
// unloads and utterances run in arrival order, and an utterance cannot be stopped once it started.

import { readFileSync } from "node:fs";
import { SpeechModel, type SpeechModelOptions } from "./audiocpp-ffi";
import { readWav, writeWav } from "./wav";

export type SpeechWorkerRequest =
  | { type: "load"; req: number; options: SpeechModelOptions }
  | { type: "unload"; req: number }
  | { type: "synthesize"; req: number; text: string; lang: string; voicePath: string; speed: number };

export type SpeechWorkerReply =
  | { type: "ok"; req: number }
  | { type: "audio"; req: number; wav: ArrayBuffer }
  | { type: "error"; req: number; message: string };

declare var self: Worker;

/** Sampling is seeded so the same sentence sounds the same when it is played again. */
const SEED = 42;

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
      const voice = readWav(readFileSync(msg.voicePath));
      // The model's duration control: 2 doubles the duration, so it is the inverse of the speed.
      const pcm = model.synthesize(msg.text, msg.lang, voice, {
        duration_factor: String(1 / msg.speed),
        seed: String(SEED),
      });
      return { type: "audio", req: msg.req, wav: writeWav(pcm) };
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

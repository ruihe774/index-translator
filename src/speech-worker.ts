// Worker thread that owns libaudiocpp. FFI calls block, so they run here and the server thread
// stays free to answer requests. Every message is handled to its end before the next one: loads,
// unloads and utterances run in arrival order. While this thread is inside the library it reads no
// messages, so an utterance is stopped through memory it shares with the server thread instead.

import { readFileSync } from "node:fs";

import { AbortedError, SpeechModel, type SpeechModelOptions, VoiceSeparator } from "./audiocpp-ffi";
import { normalizeLoudness, readWav, writeWav } from "./wav";
import { abortFlag, isAborted, type NoBody, serve } from "./worker-rpc";

interface Ok {
  type: "ok";
}
interface Audio {
  type: "audio";
  wav: ArrayBuffer;
}
/** The utterance was given up because its `abort` was set. */
interface Aborted {
  type: "aborted";
}

export interface SpeechProtocol {
  load: { request: { options: SpeechModelOptions }; reply: Ok };
  unload: { request: NoBody; reply: Ok };
  // `abort` holds one Int32: the server thread makes it non-zero when nobody wants the utterance
  // any more, and the library gives up at its next step (or the utterance is not started at all).
  synthesize: {
    request: { text: string; lang: string; voicePath: string; speed: number; abort: SharedArrayBuffer };
    reply: Audio | Aborted;
  };
  // Frees the speech model, loads the separation model, takes the vocals out of the WAV recording,
  // and frees the separation model again. The speech model is not loaded afterwards.
  separate: { request: { options: SpeechModelOptions; wav: ArrayBuffer }; reply: Audio };
}

/** Sampling is seeded so the same sentence sounds the same when it is played again. */
const SEED = 42;

let model: SpeechModel | undefined;

function unload(): void {
  model?.free();
  model = undefined;
}

serve<SpeechProtocol>({
  load: ({ options }) => {
    unload();
    model = SpeechModel.load(options);
    return { type: "ok" };
  },
  unload: () => {
    unload();
    return { type: "ok" };
  },
  synthesize: (msg) => {
    if (!model) {
      throw new Error("the speech model is not loaded");
    }
    const abort = abortFlag(msg.abort);
    // Given up while it waited behind another message.
    if (isAborted(abort)) {
      return { type: "aborted" };
    }
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
      return { type: "audio", wav: writeWav(pcm) };
    } catch (e) {
      if (e instanceof AbortedError) {
        return { type: "aborted" };
      }
      throw e;
    }
  },
  separate: (msg) => {
    // Only one of the two models is on the GPU at a time.
    unload();
    // The separation model takes 44.1 kHz, mono or stereo, and nothing else: `validateSample` has
    // checked both, so the upload goes in as it is.
    const mixture = readWav(new Uint8Array(msg.wav));
    const separator = VoiceSeparator.load(msg.options);
    try {
      return { type: "audio", wav: writeWav(normalizeLoudness(separator.vocals(mixture))) };
    } finally {
      separator.free();
    }
  },
});

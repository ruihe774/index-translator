// The mocks of test/helpers must offer what the real engines do: a test that passes against a mock
// that lacks a member (or has an extra one) says nothing about the server. The key lists below are
// `satisfies Record<keyof T, true>`, so the compiler keeps each list equal to its interface; the tests
// then check the runtime objects against the lists (types cannot say what an object really has).

import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createNativeLauncher, type Running } from "../src/llama";
import { MODELS } from "../src/models";
import { NativeSegmenter, type Segmenter } from "../src/segment";
import { NativeSpeech, type Speech } from "../src/speech";
import { type WebpageFetcher, webViewFetcher } from "../src/webpage";
import { config, tempDir } from "./helpers/harness";
import { fakeModel } from "./helpers/mock-llama";
import { segmentLauncher } from "./helpers/mock-segment";
import { speechLauncher } from "./helpers/mock-speech";
import { webpageFetcher } from "./helpers/mock-webpage";

const RUNNING = { exited: true, stop: true, countTokens: true, memory: true, generate: true } satisfies Record<
  keyof Running,
  true
>;
const SPEECH = {
  state: true,
  error: true,
  voices: true,
  addVoice: true,
  removeVoice: true,
  synthesize: true,
  transcribeProblem: true,
  canSeparate: true,
  transcribe: true,
  stop: true,
} satisfies Record<keyof Speech, true>;
const SEGMENTER = {
  state: true,
  error: true,
  aligner: true,
  segment: true,
  align: true,
  stop: true,
} satisfies Record<keyof Segmenter, true>;
const WEBPAGE = { problem: true, fetch: true } satisfies Record<keyof WebpageFetcher, true>;

/** What the mock has beyond the interface, for the tests to drive it. */
const FAKE_MODEL_EXTRAS = ["kill", "stopped"];

const names = (o: object) => Object.keys(o).sort();
const sorted = (o: Record<string, true>, extra: string[] = []) => [...Object.keys(o), ...extra].sort();

/** A thread that answers every request with a reply of any type: enough to load a model. */
function echoWorker(): Worker {
  const worker = {
    onmessage: undefined as ((e: { data: unknown }) => void) | undefined,
    onerror: undefined,
    addEventListener() {},
    postMessage(msg: { req: number }) {
      queueMicrotask(() => worker.onmessage?.({ data: { type: "loaded", req: msg.req } }));
    },
    terminate() {},
  };
  return worker as unknown as Worker;
}

const dir = tempDir("mock-contract-");

describe("the mock engines have the members of the real ones", () => {
  test("Running", async () => {
    const model = MODELS[0]!;
    await writeFile(join(dir, model.file), "");
    const real = await createNativeLauncher(echoWorker)(model, config({ modelsDir: dir }));
    expect(names(real)).toStrictEqual(sorted(RUNNING));
    expect(names(fakeModel())).toStrictEqual(sorted(RUNNING, FAKE_MODEL_EXTRAS));
  });

  test("Speech", () => {
    const real = new NativeSpeech(config());
    for (const key of Object.keys(SPEECH)) {
      expect(key in real).toBe(true);
    }
    expect(names(speechLauncher(config()))).toStrictEqual(sorted(SPEECH));
  });

  test("Segmenter", () => {
    const real = new NativeSegmenter(config());
    for (const key of Object.keys(SEGMENTER)) {
      expect(key in real).toBe(true);
    }
    const mock = segmentLauncher(config());
    expect(names(mock)).toStrictEqual(sorted(SEGMENTER));
    expect(names(mock.aligner)).toStrictEqual(["error", "state"]);
  });

  test("WebpageFetcher", () => {
    expect(names(webViewFetcher())).toStrictEqual(sorted(WEBPAGE));
    expect(names(webpageFetcher)).toStrictEqual(sorted(WEBPAGE));
  });
});

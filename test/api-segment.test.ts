// POST /segment and the `segment` part of GET /health, on the mock segmenter (no ONNX Runtime): what
// is refused before the model is asked, the queue, and how the segmenter's failures are answered.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import type { Health, Segmentation } from "../src/api";
import { type App, startApp } from "../src/app";
import { MAX_SEGMENT_CHARS, MAX_SEGMENT_TEXTS } from "../src/segment";
import {
  bodyOf,
  config,
  errorOf,
  launcher,
  mockBoundaries,
  mockSegment,
  postTo,
  resetMockSegment,
  root,
  segmentLauncher,
  speechLauncher,
  waitReady,
  webpageFetcher,
} from "./helpers/mock-engine";

let app: App;

beforeAll(async () => {
  app = await startApp(config(), launcher, speechLauncher, webpageFetcher, segmentLauncher);
  await waitReady(app);
});

afterEach(() => resetMockSegment());

afterAll(async () => {
  await app.stop();
});

const segment = (body: unknown, init: RequestInit = {}) => postTo(app.server.url.origin, "/api/v1/segment", body, init);

describe("POST /segment", () => {
  test("answers the boundaries of each text, in order", async () => {
    const texts = ["One. Two, three.", "", "No end"];
    const res = await segment({ texts });
    expect(res.status).toBe(200);
    await expect(bodyOf<Segmentation>(res)).resolves.toStrictEqual({ texts: texts.map(mockBoundaries) });
    expect(mockSegment.requests).toStrictEqual([texts]);
  });

  test.each([
    ["no texts", {}],
    ["a string", { texts: "One. Two." }],
    ["a number among them", { texts: ["One.", 2] }],
    ["none", { texts: [] }],
    ["too many", { texts: Array.from({ length: MAX_SEGMENT_TEXTS + 1 }, () => "a") }],
    ["too long in all", { texts: ["a".repeat(MAX_SEGMENT_CHARS), "b"] }],
  ])("%s is refused before the model is asked", async (_name, body) => {
    const res = await segment(body);
    expect(res.status).toBe(400);
    await expect(errorOf(res)).resolves.toMatchObject({ code: "invalid_request", details: { field: "texts" } });
    expect(mockSegment.requests).toStrictEqual([]);
  });

  test("the length limit counts UTF-16 code units, as the offsets do", async () => {
    const pairs = "😀".repeat(MAX_SEGMENT_CHARS / 2);
    expect((await segment({ texts: [pairs] })).status).toBe(200);
    expect((await segment({ texts: [pairs + "a"] })).status).toBe(400);
  });

  test("unavailable: 503 with the reason, and nothing is asked", async () => {
    mockSegment.state = "unavailable";
    const res = await segment({ texts: ["One."] });
    expect(res.status).toBe(503);
    await expect(errorOf(res)).resolves.toMatchObject({ code: "segment_unavailable" });
    expect(mockSegment.requests).toStrictEqual([]);
  });

  test("a failing model: 502 segment_error", async () => {
    mockSegment.failWith = "the model could not be loaded";
    const res = await segment({ texts: ["One."] });
    expect(res.status).toBe(502);
    await expect(errorOf(res)).resolves.toStrictEqual({
      code: "segment_error",
      message: "the model could not be loaded",
    });
  });

  test("one runs at a time; one more may wait, beyond that 429 queue_full", async () => {
    mockSegment.delayMs = 150;
    const first = segment({ texts: ["One."] });
    const second = segment({ texts: ["Two."] });
    await Bun.sleep(30);
    const third = await segment({ texts: ["Three."] });
    expect(third.status).toBe(429);
    await expect(errorOf(third)).resolves.toMatchObject({ code: "queue_full", details: { max_queue: 1 } });
    expect([(await first).status, (await second).status]).toStrictEqual([200, 200]);
    expect(mockSegment.requests).toStrictEqual([["One."], ["Two."]]);
  });

  test("the segmentation line is not the translation line", async () => {
    mockSegment.delayMs = 100;
    const segmenting = segment({ texts: ["One."] });
    await Bun.sleep(20);
    const translation = await postTo(app.server.url.origin, "/api/v1/translate", { text: "x", target_lang: "en" });
    expect(translation.status).toBe(200);
    expect((await segmenting).status).toBe(200);
  });

  test("closing the connection stops a running request", async () => {
    mockSegment.delayMs = 2000;
    const controller = new AbortController();
    const res = segment({ texts: ["One."] }, { signal: controller.signal });
    await Bun.sleep(50);
    controller.abort();
    await expect(res).rejects.toThrow();
    for (let i = 0; i < 50 && mockSegment.aborted === 0; i++) {
      await Bun.sleep(10);
    }
    expect(mockSegment.aborted).toBe(1);
    // The slot is free again.
    mockSegment.delayMs = 0;
    expect((await segment({ texts: ["Two."] })).status).toBe(200);
  });

  test("other methods: 405", async () => {
    const res = await fetch(app.server.url.origin + "/api/v1/segment");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  test("the spec documents the statuses tested here, and the limits are the server's", async () => {
    const spec = Bun.YAML.parse(await Bun.file(`${root}/docs/openapi.yaml`).text()) as {
      paths: Record<string, { post: { responses: Record<string, unknown> } }>;
      components: { schemas: { SegmentRequest: { properties: { texts: { maxItems: number } } } } };
    };
    expect(Object.keys(spec.paths["/segment"]!.post.responses).sort()).toStrictEqual(
      ["200", "400", "403", "413", "415", "429", "500", "502", "503"].sort(),
    );
    expect(spec.components.schemas.SegmentRequest.properties.texts.maxItems).toBe(MAX_SEGMENT_TEXTS);
  });
});

describe("GET /health", () => {
  test("reports the segmenter's state and the request limit", async () => {
    const health = async () => (await bodyOf<Health>(await fetch(app.server.url.origin + "/api/v1/health"))).segment;
    await expect(health()).resolves.toStrictEqual({ status: "stopped", max_chars: MAX_SEGMENT_CHARS });
    await segment({ texts: ["One."] });
    await expect(health()).resolves.toStrictEqual({ status: "ready", max_chars: MAX_SEGMENT_CHARS });
    mockSegment.state = "unavailable";
    await expect(health()).resolves.toStrictEqual({
      status: "unavailable",
      error: "the segmentation model is not installed",
      max_chars: MAX_SEGMENT_CHARS,
    });
  });
});

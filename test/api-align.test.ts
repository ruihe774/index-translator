// POST /align and the `align` part of GET /health, on the mock segmenter (no ONNX Runtime): what is
// refused before the model is asked, the shared queue with POST /segment, and the model's failures.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import type { Alignment, Health } from "../src/api";
import { type App, startApp } from "../src/app";
import { MAX_ALIGN_CHARS, MAX_ALIGN_SENTENCES } from "../src/segment";
import {
  bodyOf,
  config,
  errorOf,
  inFlight,
  launcher,
  mockAlign,
  mockPairs,
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

const align = (body: unknown, init: RequestInit = {}) => postTo(app.server.url.origin, "/api/v1/align", body, init);

describe("POST /align", () => {
  test("answers the aligner's pairs; the unit is sentences unless asked otherwise", async () => {
    const body = { source: ["One.", "Two."], target: ["Un.", "Deux.", "Trois."] };
    const res = await align(body);
    expect(res.status).toBe(200);
    await expect(bodyOf<Alignment>(res)).resolves.toStrictEqual({ pairs: mockPairs(2, 3) });
    expect(mockAlign.requests).toStrictEqual([{ unit: "sentences", ...body }]);
  });

  test("paragraphs: passed on as such, and not held to max_chars", async () => {
    const body = { unit: "paragraphs" as const, source: ["a".repeat(MAX_ALIGN_CHARS), "b"], target: ["c"] };
    const res = await align(body);
    expect(res.status).toBe(200);
    await expect(bodyOf<Alignment>(res)).resolves.toStrictEqual({ pairs: mockPairs(2, 1, "paragraphs") });
    expect(mockAlign.requests).toStrictEqual([body]);
  });

  test.each([
    ["no source", { target: ["a"] }, "source"],
    ["no target", { source: ["a"] }, "target"],
    ["a string", { source: "One.", target: ["a"] }, "source"],
    ["an empty side", { source: ["a"], target: [] }, "target"],
    ["too many", { source: ["a"], target: Array.from({ length: MAX_ALIGN_SENTENCES + 1 }, () => "a") }, "target"],
    ["too long in all", { source: ["a".repeat(MAX_ALIGN_CHARS)], target: ["b"] }, "source"],
    ["an unknown unit", { unit: "words", source: ["a"], target: ["b"] }, "unit"],
  ])("%s is refused before the model is asked", async (_name, body, field) => {
    const res = await align(body);
    expect(res.status).toBe(400);
    await expect(errorOf(res)).resolves.toMatchObject({ code: "invalid_request", details: { field } });
    expect(mockAlign.requests).toStrictEqual([]);
  });

  test("unavailable: 503 with the reason, and nothing is asked", async () => {
    mockAlign.state = "unavailable";
    const res = await align({ source: ["a"], target: ["b"] });
    expect(res.status).toBe(503);
    await expect(errorOf(res)).resolves.toStrictEqual({
      code: "align_unavailable",
      message: "the alignment model is not installed",
    });
    expect(mockAlign.requests).toStrictEqual([]);
  });

  test("a failing model: 502 segment_error", async () => {
    mockSegment.failWith = "the model could not be loaded";
    const res = await align({ source: ["a"], target: ["b"] });
    expect(res.status).toBe(502);
    await expect(errorOf(res)).resolves.toMatchObject({ code: "segment_error" });
  });

  test("waits in the segmentation line", async () => {
    mockSegment.delayMs = 150;
    const segmenting = postTo(app.server.url.origin, "/api/v1/segment", { texts: ["One."] });
    const aligning = align({ source: ["a"], target: ["b"] });
    await inFlight(app, 2);
    const third = await align({ source: ["c"], target: ["d"] });
    expect(third.status).toBe(429);
    expect([(await segmenting).status, (await aligning).status]).toStrictEqual([200, 200]);
  });

  test("the spec documents the statuses tested here, and the limits are the server's", async () => {
    const spec = Bun.YAML.parse(await Bun.file(`${root}/docs/openapi.yaml`).text()) as {
      paths: Record<string, { post: { responses: Record<string, unknown> } }>;
      components: { schemas: { AlignRequest: { properties: { source: { maxItems: number } } } } };
    };
    expect(Object.keys(spec.paths["/align"]!.post.responses).sort()).toStrictEqual(
      ["200", "400", "403", "413", "415", "429", "500", "502", "503"].sort(),
    );
    expect(spec.components.schemas.AlignRequest.properties.source.maxItems).toBe(MAX_ALIGN_SENTENCES);
  });
});

describe("GET /health", () => {
  test("reports the aligner's state and the request limit", async () => {
    const health = async () => (await bodyOf<Health>(await fetch(app.server.url.origin + "/api/v1/health"))).align;
    await expect(health()).resolves.toStrictEqual({ status: "stopped", max_chars: MAX_ALIGN_CHARS });
    await align({ source: ["a"], target: ["b"] });
    await expect(health()).resolves.toStrictEqual({ status: "ready", max_chars: MAX_ALIGN_CHARS });
  });
});

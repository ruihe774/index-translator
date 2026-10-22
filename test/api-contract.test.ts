// Contract tests for what the types generated from docs/openapi.yaml cannot say. The server builds each
// response as the type of its schema (src/api.ts, src/app.ts), and its model ids and speech languages
// are keyed by the spec's enums, so a body or an enum that drifts from the spec is a type error and
// has no test here. What is left: the numbers and defaults of the spec against the server's, that
// every documented operation and status exists, and that the spec is the one the server serves.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { type App, startApp } from "../src/app";
import { MAX_SPEECH_CHARS, MAX_SPEED, MIN_SPEED } from "../src/speech";
import { CHAT, config, launcher, mock, PNG, postTo, resetMock, waitReady } from "./helpers/mock-engine";
import { OPERATIONS, properties, spec } from "./helpers/spec";

let app: App;
let base: string;

beforeAll(async () => {
  app = await startApp(config(), launcher);
  base = app.server.url.origin;
  await waitReady(app);
});

afterEach(() => resetMock());

afterAll(() => app.stop());

const post = (path: string, body: unknown, init: RequestInit = {}) => postTo(base, path, body, init);
const plain = { text: "Hi", target_lang: "zh" };

/** Starts a second app whose engine is still loading, then runs `fn` against it. */
async function withLoadingApp<T>(fn: (origin: string) => Promise<T>): Promise<T> {
  mock.ready = false;
  const loading = await startApp(config(), launcher);
  try {
    for (let i = 0; i < 100 && loading.engine.state !== "loading"; i++) {
      await Bun.sleep(10);
    }
    expect(loading.engine.state).toBe("loading");
    return await fn(loading.server.url.origin);
  } finally {
    mock.ready = true;
    await waitReady(loading);
    await loading.stop();
  }
}

/**
 * The statuses the spec documents for a POST operation that a request can be made to produce. `500` is
 * the unexpected failure: it is documented, but no request produces it on purpose.
 */
const documentedStatuses = (path: string): string[] =>
  Object.keys(spec.paths[path]!.post!.responses)
    .filter((status) => status !== "500")
    .sort();

/** What each request in `triggers` (named by the status it is meant to get) is answered with. */
async function answers(triggers: Record<string, () => Promise<number>>): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [status, trigger] of Object.entries(triggers)) {
    out[status] = await trigger();
  }
  return out;
}

const asDocumented = (answered: Record<string, number>) =>
  Object.fromEntries(Object.keys(answered).map((status) => [status, Number(status)]));

describe("the spec against the server", () => {
  test("every documented operation exists on the server (not 404 or 405)", async () => {
    const serverBase = base + spec.servers[0]!.url;
    const answers: Record<string, number> = {};
    for (const { path: template, method } of OPERATIONS) {
      const path = template.replace("{id}", "00000000-0000-4000-8000-000000000000");
      const init: RequestInit =
        method === "post"
          ? { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
          : { method: method.toUpperCase() };
      const res = await fetch(serverBase + path, init);
      await res.text();
      answers[`${method.toUpperCase()} ${template}`] = res.status;
    }
    expect(Object.keys(answers).sort()).toStrictEqual(
      [
        "GET /health",
        "GET /languages",
        "GET /models",
        "GET /openapi.yaml",
        "GET /translations/{id}/events",
        "DELETE /translations/{id}",
        "GET /voices",
        "POST /segment",
        "POST /speech",
        "POST /tokenize",
        "POST /translate",
        "POST /voices",
        "POST /webpage",
      ].sort(),
    );
    for (const [op, status] of Object.entries(answers)) {
      // A translation that does not exist answers 404 from its own route, as an error with a message.
      const served = ![404, 405].includes(status) || op.includes("/translations/");
      expect({ op, served }).toStrictEqual({ op, served: true });
    }
  });

  test("the speech limits in the spec are the server's", () => {
    const request = properties("SpeechRequest");
    expect(request.text!.maxLength).toBe(MAX_SPEECH_CHARS);
    expect([request.speed!.minimum, request.speed!.maximum]).toStrictEqual([MIN_SPEED, MAX_SPEED]);
  });

  test("the spec's default model is the server's default", () => {
    expect(properties("TranslateRequest").model!.default).toBe(CHAT);
  });

  test("GET /openapi.yaml serves the spec as YAML", async () => {
    const res = await fetch(base + "/api/v1/openapi.yaml");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("application/yaml");
    expect(Bun.YAML.parse(await res.text())).toStrictEqual(spec);
  });

  test("every status documented for /translate can be produced by the server", async () => {
    const answered = await answers({
      "200": async () => (await post("/api/v1/translate", plain)).status,
      "400": async () => (await post("/api/v1/translate", { text: "", target_lang: "en" })).status,
      "403": async () =>
        (await post("/api/v1/translate", plain, { headers: { origin: "https://evil.example" } })).status,
      "413": async () => (await post("/api/v1/translate", { text: "x".repeat(500), target_lang: "zh" })).status,
      "415": async () =>
        (await post("/api/v1/translate", JSON.stringify(plain), { headers: { "content-type": "text/plain" } })).status,
      "429": async () => {
        mock.delayMs = 150;
        const first = post("/api/v1/translate", { text: "one", target_lang: "en" });
        const second = post("/api/v1/translate", { text: "two", target_lang: "en", stream: true });
        try {
          await Bun.sleep(30);
          return (await post("/api/v1/translate", { text: "three", target_lang: "en" })).status;
        } finally {
          await Promise.allSettled([first.then((r) => r.text()), second.then((r) => r.text())]);
          mock.delayMs = 0;
        }
      },
      "502": async () => {
        mock.failWith = "out of memory";
        try {
          return (await post("/api/v1/translate", plain)).status;
        } finally {
          mock.failWith = undefined;
        }
      },
      "503": async () => {
        mock.imageUnavailable = "the image encoder is not installed";
        try {
          return (await post("/api/v1/translate", { image: PNG.toString("base64"), target_lang: "zh" })).status;
        } finally {
          mock.imageUnavailable = undefined;
        }
      },
    });
    expect(Object.keys(answered).sort()).toStrictEqual(documentedStatuses("/translate"));
    expect(answered).toStrictEqual(asDocumented(answered));
  });

  test("every status documented for /tokenize can be produced by the server", async () => {
    const answered = await answers({
      "200": async () => (await post("/api/v1/tokenize", plain)).status,
      "400": async () => (await post("/api/v1/tokenize", { text: "", target_lang: "en" })).status,
      "403": async () =>
        (await post("/api/v1/tokenize", plain, { headers: { origin: "https://evil.example" } })).status,
      "413": async () => (await post("/api/v1/tokenize", JSON.stringify(plain) + " ".repeat(4 * 1024 * 1024))).status,
      "415": async () =>
        (await post("/api/v1/tokenize", JSON.stringify(plain), { headers: { "content-type": "text/plain" } })).status,
      "503": () => withLoadingApp(async (origin) => (await postTo(origin, "/api/v1/tokenize", plain)).status),
    });
    expect(Object.keys(answered).sort()).toStrictEqual(documentedStatuses("/tokenize"));
    expect(answered).toStrictEqual(asDocumented(answered));
  });
});

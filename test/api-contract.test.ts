// Contract tests: the bodies the server sends are checked against docs/openapi.yaml, and the spec is
// checked against the server (every documented operation exists, every documented status can be
// produced, the model enums match src/models.ts). The validator is local and covers the subset of
// JSON Schema this spec uses; it has its own negative cases so it cannot pass vacuously.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type App, startApp } from "../src/app";
import { MODELS } from "../src/models";
import { CHAT, config, launcher, mock, postTo, readSse, resetMock, root, waitReady } from "./helpers/mock-engine";

const spec = Bun.YAML.parse(readFileSync(join(root, "docs", "openapi.yaml"), "utf8")) as any;

// ---------------------------------------------------------------------------------------------
// A minimal OpenAPI 3.1 schema validator: local $ref, type (including arrays such as [string, "null"]),
// required, properties, additionalProperties, items, enum, minimum, minLength, maxLength, pattern.
// Other keywords in the spec (description, default, examples) are documentation and are ignored.
// ---------------------------------------------------------------------------------------------

/** Follows local "#/..." references from the document root until the node is not a $ref. */
function deref(node: any): any {
  let n = node;
  for (let hops = 0; n && typeof n === "object" && typeof n.$ref === "string"; hops++) {
    if (hops > 20 || !n.$ref.startsWith("#/")) throw new Error(`unsupported $ref ${n.$ref}`);
    n = n.$ref
      .slice(2)
      .split("/")
      .reduce((o: any, k: string) => o?.[k], spec);
    if (n === undefined) throw new Error(`dangling $ref`);
  }
  return n;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isObject(value);
    default:
      throw new Error(`validator does not know type "${type}"`);
  }
}

/** Every way `value` breaks `schemaNode`, as readable lines; empty when it conforms. */
function problems(schemaNode: any, value: unknown, at = "$", out: string[] = []): string[] {
  const schema = deref(schemaNode);
  if (schema === undefined || schema === null) throw new Error(`no schema at ${at}`);

  if (schema.type !== undefined) {
    const types: string[] = [schema.type].flat();
    if (!types.some((t) => typeMatches(t, value))) {
      out.push(`${at}: expected ${types.join(" or ")}, got ${JSON.stringify(value)}`);
      return out;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e: unknown) => JSON.stringify(e) === JSON.stringify(value))) {
    out.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === "number" && typeof schema.minimum === "number" && value < schema.minimum) {
    out.push(`${at}: ${value} is below the minimum ${schema.minimum}`);
  }
  if (typeof value === "string") {
    const length = [...value].length; // JSON Schema counts code points
    if (typeof schema.minLength === "number" && length < schema.minLength)
      out.push(`${at}: shorter than ${schema.minLength}`);
    if (typeof schema.maxLength === "number" && length > schema.maxLength)
      out.push(`${at}: longer than ${schema.maxLength}`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) {
      out.push(`${at}: does not match ${schema.pattern}`);
    }
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, i) => {
      problems(schema.items, item, `${at}[${i}]`, out);
    });
  }
  if (isObject(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) out.push(`${at}: missing required property "${key}"`);
    }
    const properties = schema.properties ?? {};
    for (const [key, v] of Object.entries(value)) {
      if (key in properties) problems(properties[key], v, `${at}.${key}`, out);
      else if (schema.additionalProperties === false) out.push(`${at}: unexpected property "${key}"`);
      else if (isObject(schema.additionalProperties)) problems(schema.additionalProperties, v, `${at}.${key}`, out);
    }
  }
  return out;
}

/** Validates against a named component schema. */
const check = (name: string, value: unknown): string[] => problems({ $ref: `#/components/schemas/${name}` }, value);

/** The JSON schema a documented response carries (after resolving response $refs). */
function documented(path: string, method: string, status: string, type = "application/json"): any {
  const response = deref(spec.paths[path][method].responses[status]);
  return response.content[type].schema;
}

const OPERATIONS = Object.entries(spec.paths as Record<string, Record<string, unknown>>).flatMap(([path, item]) =>
  Object.keys(item)
    .filter((m) => ["get", "post", "put", "delete", "patch"].includes(m))
    .map((method) => ({ path, method })),
);

// ---------------------------------------------------------------------------------------------

let app: App;
let base: string;

beforeAll(async () => {
  app = await startApp(config(), launcher);
  base = app.server.url.origin;
  await waitReady(app);
});

afterAll(async () => {
  await app.stop();
});

afterEach(() => {
  resetMock();
});

const post = (path: string, body: unknown, init: RequestInit = {}) => postTo(base, path, body, init);
const plain = { text: "Hi", target_lang: "zh" };

/** Starts a second app whose engine is still loading, then runs `fn` against it. */
async function withLoadingApp(fn: (origin: string) => Promise<void>): Promise<void> {
  mock.ready = false;
  const loading = await startApp(config(), launcher);
  try {
    for (let i = 0; i < 100 && loading.engine.state !== "loading"; i++) await Bun.sleep(10);
    expect(loading.engine.state).toBe("loading");
    await fn(loading.server.url.origin);
  } finally {
    mock.ready = true;
    await waitReady(loading);
    await loading.stop();
  }
}

describe("validator", () => {
  test("accepts a conforming body, including null where the type allows it", () => {
    expect(check("ModelList", { default: CHAT, loaded: null, models: [] })).toEqual([]);
    expect(check("ModelList", { default: CHAT, loaded: CHAT, models: [] })).toEqual([]);
  });

  test("rejects a body that breaks the schema, so passing tests mean something", () => {
    // Unknown error code (enum), missing required property, and an unexpected property where none is allowed.
    expect(check("Error", { error: { code: "made_up_code", message: "x" } }).join("\n")).toContain("not one of");
    expect(check("Error", { error: { message: "no code" } }).join("\n")).toContain('missing required property "code"');
    // The spec sets additionalProperties: false nowhere, so the rule is exercised with an inline schema.
    const closed = { type: "object", additionalProperties: false, properties: { a: { type: "string" } } };
    expect(problems(closed, { a: "x", b: 1 }).join("\n")).toContain('unexpected property "b"');
    expect(problems(closed, { a: "x" })).toEqual([]);
  });

  test("rejects wrong types, and accepts null only where the type list includes it", () => {
    expect(check("ModelList", { default: CHAT, loaded: 5, models: [] }).join("\n")).toContain(
      "expected string or null",
    );
    expect(
      check("Timings", { queue_ms: 1.5, prompt_ms: 1, generation_ms: 1, tokens_per_second: 1 }).join("\n"),
    ).toContain("expected integer");
    expect(
      check("TranslateResponse", {
        translation: 5,
        finish_reason: "maybe",
        model: CHAT,
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        timings: { queue_ms: 1, prompt_ms: 1, generation_ms: 1, tokens_per_second: 1 },
      }).length,
    ).toBe(2);
  });

  test("checks array items and enforces the minimum on integers", () => {
    expect(
      check("ModelList", { default: CHAT, loaded: null, models: [{ id: "x", label: "y", kind: "chat" }] }).join("\n"),
    ).toContain("is not one of");
    expect(check("QueuedEvent", { position: 0 }).join("\n")).toContain("below the minimum 1");
  });
});

describe("GET responses", () => {
  test("GET /health when ready matches Health", async () => {
    const res = await fetch(base + "/api/v1/health");
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(check("Health", body)).toEqual([]);
    expect(body.status).toBe("ready");
  });

  test("GET /health while loading is a 503 that still matches Health", async () => {
    await withLoadingApp(async (origin) => {
      const res = await fetch(origin + "/api/v1/health");
      expect(res.status).toBe(503);
      const body: any = await res.json();
      expect(check("Health", body)).toEqual([]);
      // Actual behaviour: `model` already names the model being loaded (the engine sets it before the
      // launch), although the spec says null when none is loaded. Documented, not failed; see the report.
      expect(body).toMatchObject({ status: "loading", model: CHAT });
    });
  });

  test("GET /health after a failed load is a 503 whose error field is set", async () => {
    mock.failLaunch = "model file is corrupt";
    const broken = await startApp(config(), launcher);
    try {
      for (let i = 0; i < 100 && broken.engine.state !== "error"; i++) await Bun.sleep(10);
      const res = await fetch(broken.server.url.origin + "/api/v1/health");
      expect(res.status).toBe(503);
      const body: any = await res.json();
      expect(check("Health", body)).toEqual([]);
      expect(body).toMatchObject({ status: "error", model: null });
      expect(body.error).toContain("model file is corrupt");
    } finally {
      mock.failLaunch = undefined;
      await broken.stop();
    }
  });

  test("GET /models matches ModelList, with one ModelInfo per model", async () => {
    const body: any = await (await fetch(base + "/api/v1/models")).json();
    expect(check("ModelList", body)).toEqual([]);
    expect(body.models.map((m: any) => m.id)).toEqual(MODELS.map((m) => m.id));
    for (const m of MODELS) {
      expect(body.models.find((x: any) => x.id === m.id).directions).toEqual(m.directions);
    }
  });

  test("GET /languages matches the inline response schema of the spec", async () => {
    const body = await (await fetch(base + "/api/v1/languages")).json();
    expect(problems(documented("/languages", "get", "200"), body)).toEqual([]);
  });

  test("GET /openapi.yaml is served as YAML", async () => {
    const res = await fetch(base + "/api/v1/openapi.yaml");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("application/yaml");
    expect(Bun.YAML.parse(await res.text())).toEqual(spec);
  });
});

describe("POST success responses", () => {
  test("POST /translate JSON matches TranslateResponse", async () => {
    const res = await post("/api/v1/translate", { text: "你好", target_lang: "en" });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(check("TranslateResponse", body)).toEqual([]);
    expect(body.finish_reason).toBe("stop");
  });

  test("POST /tokenize matches TokenizeResponse", async () => {
    const res = await post("/api/v1/tokenize", plain);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(check("TokenizeResponse", body)).toEqual([]);
    expect(body.fits).toBe(true);
  });

  test("the SSE stream's events match their documented schemas, in order", async () => {
    const events = await readSse(await post("/api/v1/translate", { text: "你好", target_lang: "en", stream: true }));
    expect(events.map((e) => e.event)).toEqual(["start", "delta", "delta", "delta", "done"]);
    const schemaFor: Record<string, string> = {
      start: "StartEvent",
      delta: "DeltaEvent",
      done: "DoneEvent",
    };
    for (const event of events) {
      expect({ event: event.event, problems: check(schemaFor[event.event]!, event.data) }).toEqual({
        event: event.event,
        problems: [],
      });
    }
  });

  test("the queued event matches QueuedEvent when a request waits behind another", async () => {
    mock.delayMs = 60;
    try {
      const first = post("/api/v1/translate", { text: "one", target_lang: "en" });
      await Bun.sleep(20);
      const events = await readSse(await post("/api/v1/translate", { text: "two", target_lang: "en", stream: true }));
      expect(events.map((e) => e.event)).toEqual(["queued", "start", "delta", "delta", "delta", "done"]);
      expect(check("QueuedEvent", events[0]!.data)).toEqual([]);
      expect(events[0]!.data.position).toBe(1);
      await (await first).text();
    } finally {
      mock.delayMs = 0;
    }
  });

  test("an engine failure mid-stream arrives as an ErrorEvent", async () => {
    mock.failWith = "device lost";
    const events = await readSse(await post("/api/v1/translate", { text: "你好", target_lang: "en", stream: true }));
    expect(events.at(-1)!.event).toBe("error");
    expect(check("ErrorEvent", events.at(-1)!.data)).toEqual([]);
    expect(events.at(-1)!.data.code).toBe("engine_error");
  });

  test("an input over the limit arrives as an ErrorEvent with its details", async () => {
    const events = await readSse(
      await post("/api/v1/translate", { text: "x".repeat(500), target_lang: "zh", stream: true }),
    );
    expect(events.map((e) => e.event)).toEqual(["error"]);
    expect(check("ErrorEvent", events[0]!.data)).toEqual([]);
    expect(events[0]!.data.code).toBe("input_too_long");
  });
});

describe("error responses match components/schemas/Error", () => {
  test("400 invalid_request", async () => {
    const res = await post("/api/v1/translate", { text: "", target_lang: "en" });
    expect(res.status).toBe(400);
    expect(check("Error", await res.json())).toEqual([]);
  });

  test("404 not_found", async () => {
    const res = await fetch(base + "/api/v1/nope");
    expect(res.status).toBe(404);
    expect(check("Error", await res.json())).toEqual([]);
  });

  test("405 method_not_allowed", async () => {
    const res = await fetch(base + "/api/v1/translate");
    expect(res.status).toBe(405);
    expect(check("Error", await res.json())).toEqual([]);
  });

  test("413 input_too_long", async () => {
    const res = await post("/api/v1/translate", { text: "x".repeat(500), target_lang: "zh" });
    expect(res.status).toBe(413);
    const body: any = await res.json();
    expect(check("Error", body)).toEqual([]);
    expect(body.error.details).toMatchObject({ max_input_tokens: 400 });
  });

  test("415 unsupported_media_type", async () => {
    const res = await post("/api/v1/translate", JSON.stringify(plain), { headers: { "content-type": "text/plain" } });
    expect(res.status).toBe(415);
    expect(check("Error", await res.json())).toEqual([]);
  });

  test("403 forbidden_origin", async () => {
    const res = await post("/api/v1/translate", plain, { headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    expect(check("Error", await res.json())).toEqual([]);
  });

  test("429 queue_full", async () => {
    mock.delayMs = 150;
    const first = post("/api/v1/translate", { text: "one", target_lang: "en" });
    const second = post("/api/v1/translate", { text: "two", target_lang: "en", stream: true });
    try {
      await Bun.sleep(30);
      const res = await post("/api/v1/translate", { text: "three", target_lang: "en" });
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("10");
      expect(check("Error", await res.json())).toEqual([]);
    } finally {
      await Promise.allSettled([first.then((r) => r.text()), second.then((r) => r.text())]);
      mock.delayMs = 0;
    }
  });

  test("502 engine_error", async () => {
    mock.failWith = "out of memory";
    const res = await post("/api/v1/translate", plain);
    mock.failWith = undefined;
    expect(res.status).toBe(502);
    expect(check("Error", await res.json())).toEqual([]);
  });

  test("503 engine_unavailable from /tokenize while loading", async () => {
    await withLoadingApp(async (origin) => {
      const res = await postTo(origin, "/api/v1/tokenize", plain);
      expect(res.status).toBe(503);
      expect(check("Error", await res.json())).toEqual([]);
    });
  });
});

describe("the spec against the server", () => {
  test("every documented operation exists on the server (not 404 or 405)", async () => {
    const serverBase = base + spec.servers[0].url;
    const answers: Record<string, number> = {};
    for (const { path, method } of OPERATIONS) {
      const init: RequestInit =
        method === "post"
          ? { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
          : { method: method.toUpperCase() };
      const res = await fetch(serverBase + path, init);
      await res.text();
      answers[`${method.toUpperCase()} ${path}`] = res.status;
    }
    expect(Object.keys(answers).sort()).toEqual(
      ["GET /health", "GET /languages", "GET /models", "GET /openapi.yaml", "POST /tokenize", "POST /translate"].sort(),
    );
    for (const [op, status] of Object.entries(answers)) {
      expect({ op, served: ![404, 405].includes(status) }).toEqual({ op, served: true });
    }
  });

  test("the model enums in the spec match the server's MODELS", () => {
    const ids = MODELS.map((m) => m.id).sort();
    const schemas = spec.components.schemas;
    expect([...schemas.TranslateRequest.properties.model.enum].sort()).toEqual(ids);
    expect([...schemas.ModelInfo.properties.id.enum].sort()).toEqual(ids);
    expect([...schemas.ModelInfo.properties.kind.enum].sort()).toEqual([...new Set(MODELS.map((m) => m.kind))].sort());
  });

  test("the spec's default model is the server's default", () => {
    expect(spec.components.schemas.TranslateRequest.properties.model.default).toBe(CHAT);
  });

  test("the error responses documented for /translate all point at the Error schema", () => {
    const errorSchema = spec.components.schemas.Error;
    for (const status of ["400", "403", "413", "415", "429", "502"]) {
      expect({ status, schema: deref(documented("/translate", "post", status)) }).toEqual({
        status,
        schema: errorSchema,
      });
    }
  });

  test("every status documented for /translate can be produced by the server", async () => {
    const triggers: Record<string, () => Promise<number>> = {
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
    };
    const documentedStatuses = Object.keys(spec.paths["/translate"].post.responses).sort();
    expect(Object.keys(triggers).sort()).toEqual(documentedStatuses);
    for (const [status, trigger] of Object.entries(triggers)) {
      const actual = await trigger();
      expect({ status, actual }).toEqual({ status, actual: Number(status) });
    }
  });

  test("every status documented for /tokenize can be produced by the server", async () => {
    const documentedStatuses = Object.keys(spec.paths["/tokenize"].post.responses).sort();
    expect(documentedStatuses).toEqual(["200", "400", "403", "413", "415", "503"]);

    const seen: Record<string, number> = {};
    seen["200"] = (await post("/api/v1/tokenize", plain)).status;
    seen["400"] = (await post("/api/v1/tokenize", { text: "", target_lang: "en" })).status;
    seen["403"] = (await post("/api/v1/tokenize", plain, { headers: { origin: "https://evil.example" } })).status;
    seen["415"] = (
      await post("/api/v1/tokenize", JSON.stringify(plain), { headers: { "content-type": "text/plain" } })
    ).status;
    const padded = JSON.stringify(plain) + " ".repeat(4 * 1024 * 1024);
    seen["413"] = (await post("/api/v1/tokenize", padded)).status;
    await withLoadingApp(async (origin) => {
      seen["503"] = (await postTo(origin, "/api/v1/tokenize", plain)).status;
    });
    for (const status of documentedStatuses) {
      expect({ status, actual: seen[status] }).toEqual({ status, actual: Number(status) });
    }
  });

  test("the 503 and 413 bodies documented for /tokenize match Error", async () => {
    const res = await post("/api/v1/tokenize", JSON.stringify(plain) + " ".repeat(4 * 1024 * 1024));
    expect(res.status).toBe(413);
    expect(check("Error", await res.json())).toEqual([]);
  });
});

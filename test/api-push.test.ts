// Web Push for resumable jobs (`PUT /translations/{id}/push`, src/push.ts) against the mock engine, with a
// sender that records what it would send.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import type { Health, PushMessage } from "../src/api";
import { type App, startApp } from "../src/app";
import type { PushSender, Subscription } from "../src/push";
import { config, errorOf, launcher, mock, postTo, resetMock, until, waitReady } from "./helpers/mock-engine";

const sent: { to: Subscription; message: PushMessage; ttlSeconds: number }[] = [];
const sender: PushSender = {
  publicKey: "BKey",
  // eslint-disable-next-line @typescript-eslint/require-await -- the real one sends a request
  async send(to, payload, ttlSeconds) {
    sent.push({ to, message: JSON.parse(payload) as PushMessage, ttlSeconds });
  },
};

let app: App;
let off: App;
let base: string;

beforeAll(async () => {
  app = await startApp(config(), launcher, undefined, undefined, undefined, undefined, () => Promise.resolve(sender));
  off = await startApp(config(), launcher);
  base = app.server.url.origin;
  await waitReady(app);
});

afterEach(() => {
  resetMock();
  sent.length = 0;
});

afterAll(async () => {
  await app.stop();
  await off.stop();
});

const keys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const subscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
  expirationTime: null,
  keys: {
    p256dh: new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)).toBase64({
      alphabet: "base64url",
      omitPadding: true,
    }),
    auth: crypto.getRandomValues(new Uint8Array(16)).toBase64({ alphabet: "base64url", omitPadding: true }),
  },
};

const start = (origin = base) =>
  postTo(origin, "/api/v1/translate", { text: "你好", target_lang: "en", stream: true, resumable: true });

const subscribe = (id: string, body: unknown = subscription, origin = base) =>
  fetch(`${origin}/api/v1/translations/${id}/push`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** Starts a slow translation, subscribes it and gives back its id and the reader of its stream. */
async function subscribed() {
  mock.delayMs = 40;
  const res = await start();
  const id = res.headers.get("x-translation-id")!;
  const reader = res.body!.getReader();
  await reader.read();
  expect((await subscribe(id)).status).toBe(204);
  return { id, reader };
}

describe("push", () => {
  test("/health gives the key to subscribe with, or says push is off", async () => {
    const on = (await (await fetch(`${base}/api/v1/health`)).json()) as Health;
    expect(on.push).toStrictEqual({ status: "available", public_key: "BKey" });
    const without = (await (await fetch(`${off.server.url.origin}/api/v1/health`)).json()) as Health;
    expect(without.push?.status).toBe("unavailable");
  });

  test("a job that ends with nobody reading it sends one message", async () => {
    const { id, reader } = await subscribed();
    await reader.cancel();
    await until(() => sent.length > 0, "the push message");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message).toStrictEqual({ job: "translation", id, outcome: "done", text: "Hello, world" });
    expect(sent[0]!.to.endpoint.href).toBe(subscription.endpoint);
    expect(sent[0]!.ttlSeconds).toBe(600);
  });

  test("a failed job's message carries the error", async () => {
    mock.failWith = "out of memory";
    const { id, reader } = await subscribed();
    await reader.cancel();
    await until(() => sent.length > 0, "the push message");
    expect(sent[0]!.message).toMatchObject({ job: "translation", id, outcome: "error" });
    expect(sent[0]!.message.text).toContain("out of memory");
  });

  test("a job read to its end, or cancelled, sends nothing", async () => {
    const read = await subscribed();
    for (let r = await read.reader.read(); !r.done; r = await read.reader.read()) {
      // read to the end: the reader is there when the job ends
    }
    const cancelled = await subscribed();
    await cancelled.reader.cancel();
    expect((await fetch(`${base}/api/v1/translations/${cancelled.id}`, { method: "DELETE" })).status).toBe(204);
    await Bun.sleep(300);
    expect(sent).toHaveLength(0);
  });

  test("only a browser's push service is accepted as the endpoint", async () => {
    const { id, reader } = await subscribed();
    for (const endpoint of [
      "http://fcm.googleapis.com/fcm/send/x",
      "https://127.0.0.1/x",
      "https://fcm.googleapis.com:8443/x",
      "https://evil.example/updates.push.services.mozilla.com",
      "not a url",
    ]) {
      const res = await subscribe(id, { ...subscription, endpoint });
      expect(res.status).toBe(400);
      expect((await errorOf(res)).details).toStrictEqual({ field: "endpoint" });
    }
    const short = await subscribe(id, { ...subscription, keys: { ...subscription.keys, auth: "AAAA" } });
    expect((await errorOf(short)).details).toStrictEqual({ field: "keys.auth" });
    expect((await subscribe("00000000-0000-4000-8000-000000000000")).status).toBe(404);
    await reader.cancel();
  });

  test("without PUSH_CONTACT subscribing is a 503", async () => {
    const res = await start(off.server.url.origin);
    const id = res.headers.get("x-translation-id")!;
    const refused = await subscribe(id, subscription, off.server.url.origin);
    expect(refused.status).toBe(503);
    expect((await errorOf(refused)).code).toBe("push_unavailable");
    await res.text();
  });
});

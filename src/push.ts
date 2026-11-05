// Web Push (`PUSH=1`): a notification when a resumable job ends while nobody reads its events (a phone
// that left the page, a closed tab). The browser chose the push service when the page subscribed; the
// server only POSTs to the subscription's endpoint, the payload encrypted to the subscription's keys
// (RFC 8291, `aes128gcm`) and signed with a VAPID key of its own (RFC 8292). No account with any
// push service is needed. The VAPID key is made at startup and kept in memory only: after a restart
// the page sees another `public_key` in `/health` and subscribes again.
//
// The server makes the request, so only the push services of the browsers are reachable from it
// (`PUSH_HOSTS`): an endpoint is a URL from an unauthenticated client.

import type { Config } from "./config";
import { invalid } from "./http";

/** A subscription as the page sends it (`PushSubscription.toJSON()`), checked. */
export interface Subscription {
  endpoint: URL;
  /** The browser's P-256 public key, uncompressed (65 bytes). */
  p256dh: Uint8Array<ArrayBuffer>;
  /** The shared authentication secret (16 bytes). */
  auth: Uint8Array<ArrayBuffer>;
}

export interface PushSender {
  /** The VAPID public key (uncompressed P-256, base64url): the page's `applicationServerKey`. */
  publicKey: string;
  /** Sends `payload` to `to`; the push service keeps it `ttlSeconds` for a browser that is offline. Never throws. */
  send(to: Subscription, payload: string, ttlSeconds: number): Promise<void>;
}

/** Makes the sender for `cfg`, or undefined when push is off. */
export type PushLauncher = (cfg: Config) => Promise<PushSender | undefined>;

/** The push services of Chrome (and Opera, Samsung Internet), Firefox, Safari and Edge. `*.` is any subdomain. */
const PUSH_HOSTS = ["fcm.googleapis.com", "*.push.services.mozilla.com", "*.push.apple.com", "*.notify.windows.com"];
/** A push service that does not answer in this time is given up on: the notification is a courtesy. */
const SEND_TIMEOUT_MS = 10_000;
/** How long a VAPID token is valid; RFC 8292 allows at most 24 hours. */
const TOKEN_SECONDS = 12 * 60 * 60;
/** One record holds the whole payload: push services take at most 4096 bytes. */
const RECORD_SIZE = 4096;

const P256 = { name: "ECDH", namedCurve: "P-256" } as const;
const encoder = new TextEncoder();

const base64url = (bytes: Uint8Array) => bytes.toBase64({ alphabet: "base64url", omitPadding: true });

function fromBase64url(text: unknown, length: number, field: string): Uint8Array<ArrayBuffer> {
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  try {
    bytes = typeof text === "string" ? Uint8Array.fromBase64(text, { alphabet: "base64url" }) : undefined;
  } catch {}
  if (bytes?.length !== length) {
    throw invalid(`${field} must be ${length} bytes in base64url`, field);
  }
  return bytes;
}

export function isPushHost(hostname: string): boolean {
  return PUSH_HOSTS.some((h) => (h.startsWith("*.") ? hostname.endsWith(h.slice(1)) : hostname === h));
}

/** Reads `PushSubscription.toJSON()`; anything else, or an endpoint off the known push services, is a 400. */
export function parseSubscription(body: Record<string, unknown>): Subscription {
  let endpoint: URL | undefined;
  try {
    endpoint = typeof body.endpoint === "string" ? new URL(body.endpoint) : undefined;
  } catch {}
  if (
    endpoint?.protocol !== "https:" ||
    endpoint.port !== "" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    !isPushHost(endpoint.hostname)
  ) {
    throw invalid("endpoint must be the https address of a browser's push service", "endpoint");
  }
  const keys = typeof body.keys === "object" && body.keys !== null ? (body.keys as Record<string, unknown>) : {};
  const p256dh = fromBase64url(keys.p256dh, 65, "keys.p256dh");
  if (p256dh[0] !== 4) {
    throw invalid("keys.p256dh must be an uncompressed P-256 point", "keys.p256dh");
  }
  return { endpoint, p256dh, auth: fromBase64url(keys.auth, 16, "keys.auth") };
}

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: ArrayBuffer, info: Uint8Array<ArrayBuffer>, bytes: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8);
}

/** For the RFC's test vector: the sender's key pair and the salt are otherwise new for every message. */
export interface EncryptionSeed {
  keys: CryptoKeyPair;
  salt: Uint8Array<ArrayBuffer>;
}

/** The body of a push message: RFC 8188's `aes128gcm` header and one record, keyed as RFC 8291 says. */
export async function encryptPayload(to: Subscription, plaintext: Uint8Array, seed?: EncryptionSeed) {
  const keys = seed?.keys ?? (await crypto.subtle.generateKey(P256, true, ["deriveBits"]));
  const salt = seed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const senderPublic = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  const browserKey = await crypto.subtle.importKey("raw", to.p256dh, P256, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: browserKey }, keys.privateKey, 256);
  const keyInfo = new Uint8Array([...encoder.encode("WebPush: info\0"), ...to.p256dh, ...senderPublic]);
  const ikm = await hkdf(to.auth, shared, keyInfo, 32);
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  const record = new Uint8Array([...plaintext, 2]); // 2: the last record, no padding
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, record));
  if (sealed.length + 86 > RECORD_SIZE) {
    throw new RangeError("a push payload must fit one record");
  }
  const header = new Uint8Array(21);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = senderPublic.length;
  return new Uint8Array([...header, ...senderPublic, ...sealed]);
}

/** A sender with a new VAPID key; `contact` is the `sub` claim (`mailto:` or `https:`), how a push service reaches the operator. */
export async function createPushSender(contact: string): Promise<PushSender> {
  const vapid = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const publicKey = base64url(new Uint8Array(await crypto.subtle.exportKey("raw", vapid.publicKey)));

  async function token(audience: string): Promise<string> {
    const part = (o: object) => base64url(encoder.encode(JSON.stringify(o)));
    const exp = Math.floor(Date.now() / 1000) + TOKEN_SECONDS;
    const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: audience, exp, sub: contact })}`;
    // WebCrypto signs ECDSA as r || s, which is what JWS's ES256 wants.
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      vapid.privateKey,
      encoder.encode(unsigned),
    );
    return `${unsigned}.${base64url(new Uint8Array(signature))}`;
  }

  return {
    publicKey,
    async send(to, payload, ttlSeconds) {
      try {
        const res = await fetch(to.endpoint, {
          method: "POST",
          headers: {
            authorization: `vapid t=${await token(to.endpoint.origin)}, k=${publicKey}`,
            "content-encoding": "aes128gcm",
            "content-type": "application/octet-stream",
            ttl: String(Math.round(ttlSeconds)),
            urgency: "normal",
          },
          body: await encryptPayload(to, encoder.encode(payload)),
          redirect: "error",
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        if (!res.ok) {
          console.warn(`push: ${to.endpoint.hostname} answered ${res.status} ${await res.text().catch(() => "")}`);
        }
      } catch (e) {
        console.warn(`push: ${to.endpoint.hostname} could not be reached: ${String(e)}`);
      }
    },
  };
}

/** Characters (graphemes) of the result's opening and of its close that a notification shows. */
const PREVIEW_HEAD = 60;
const PREVIEW_TAIL = 60;
/** How far a cut may move back to a space so as not to split a word; a result this much longer than both is shown whole. */
const PREVIEW_SLACK = 20;
/** What is kept of each end as it streams, in UTF-16 units: far more than is shown, as whitespace collapses. */
const PREVIEW_KEEP = 2000;

const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}\p{M}]/u.test(c);
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** `text` with its whitespace collapsed, as characters: an emoji or a letter with its marks is one. */
const characters = (text: string) =>
  Array.from(graphemes.segment(text.replaceAll(/\s+/g, " ").trim()), (s) => s.segment);

/**
 * The opening and closing words of a result that streams in pieces (`delta` events, transcript
 * segments): only both ends are kept, so a long result costs no more than a short one. Pieces are
 * tokens, not words, so a cut inside a word moves back to the nearest space when there is one
 * close by; text without spaces (Chinese, Japanese) is cut between any two characters.
 */
export class Preview {
  private head = "";
  private tail = "";
  /** All of it, while it is short enough to be shown whole. */
  private whole: string | undefined = "";

  add(text: string): void {
    if (this.head.length < PREVIEW_KEEP) {
      this.head += text;
    }
    this.tail += text;
    if (this.tail.length > 2 * PREVIEW_KEEP) {
      this.tail = this.tail.slice(-PREVIEW_KEEP);
    }
    if (this.whole !== undefined) {
      this.whole += text;
      if (this.whole.length > PREVIEW_KEEP) {
        this.whole = undefined;
      }
    }
  }

  /** `opening … close`, the whole text when it is short, or undefined when there is none. */
  text(): string | undefined {
    const all = this.whole === undefined ? undefined : characters(this.whole);
    if (all && all.length <= PREVIEW_HEAD + PREVIEW_TAIL + PREVIEW_SLACK) {
      return all.length > 0 ? all.join("") : undefined;
    }
    const start = characters(this.head);
    let head = start.slice(0, PREVIEW_HEAD);
    if (isWordChar(head.at(-1)) && isWordChar(start[PREVIEW_HEAD])) {
      const space = head.lastIndexOf(" ");
      if (space >= PREVIEW_HEAD - PREVIEW_SLACK) {
        head = head.slice(0, space);
      }
    }
    // The kept end may start in the middle of a character; that piece is far from what is shown.
    const end = characters(this.tail);
    let tail = end.slice(-PREVIEW_TAIL);
    if (isWordChar(tail[0]) && isWordChar(end.at(-PREVIEW_TAIL - 1))) {
      const space = tail.indexOf(" ");
      if (space !== -1 && space < PREVIEW_SLACK) {
        tail = tail.slice(space + 1);
      }
    }
    return `${head.join("").trimEnd()} … ${tail.join("").trimStart()}`;
  }
}

export const webPush: PushLauncher = async (cfg) => (cfg.push ? createPushSender(cfg.pushContact) : undefined);

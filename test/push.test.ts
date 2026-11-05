import { describe, expect, test } from "bun:test";

import { encryptPayload, isPushHost, Preview } from "../src/push";

const bytes = (b64: string) => Uint8Array.fromBase64(b64, { alphabet: "base64url" });

/** The P-256 key pair of RFC 8291's example (section 5), from its raw private and public halves. */
async function keyPair(d: string, publicKey: string): Promise<CryptoKeyPair> {
  const point = bytes(publicKey);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: point.slice(1, 33).toBase64({ alphabet: "base64url", omitPadding: true }),
    y: point.slice(33).toBase64({ alphabet: "base64url", omitPadding: true }),
  };
  const ecdh = { name: "ECDH", namedCurve: "P-256" };
  return {
    privateKey: await crypto.subtle.importKey("jwk", { ...jwk, d }, ecdh, true, ["deriveBits"]),
    publicKey: await crypto.subtle.importKey("jwk", jwk, ecdh, true, []),
  };
}

describe("encryptPayload", () => {
  test("matches RFC 8291's example", async () => {
    const keys = await keyPair(
      "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
      "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
    );
    const body = await encryptPayload(
      {
        endpoint: new URL("https://fcm.googleapis.com/fcm/send/x"),
        p256dh: bytes("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
        auth: bytes("BTBZMqHH6r4Tts7J_aSIgg"),
      },
      new TextEncoder().encode("When I grow up, I want to be a watermelon"),
      { keys, salt: bytes("DGv6ra1nlYgDCS1FRnbzlw") },
    );
    expect(body.toBase64({ alphabet: "base64url", omitPadding: true })).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });
});

describe("isPushHost", () => {
  test("takes the push services of the browsers and nothing else", () => {
    for (const host of ["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"]) {
      expect(isPushHost(host)).toBe(true);
    }
    expect(isPushHost("wns2-by3p.notify.windows.com")).toBe(true);
    for (const host of [
      "googleapis.com",
      "push.apple.com",
      "evilpush.apple.com",
      "notify.windows.com.example",
      "localhost",
    ]) {
      expect(isPushHost(host)).toBe(false);
    }
  });
});

describe("Preview", () => {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const length = (text: string) => Array.from(segmenter.segment(text)).length;
  const of = (...pieces: string[]) => {
    const p = new Preview();
    for (const piece of pieces) {
      p.add(piece);
    }
    return p.text();
  };

  test("a short result is shown whole, its whitespace collapsed", () => {
    expect(of("Hello", ",\n\n", " world", "\n")).toBe("Hello, world");
    expect(of()).toBeUndefined();
    expect(of("\n", "  ")).toBeUndefined();
  });

  test("a long one is its opening and its close, cut between words", () => {
    const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    // Pieces are tokens, not words: the cuts must not depend on where they fall.
    const [head, tail] = of(...words.match(/.{1,3}/gs)!)!.split(" … ");
    expect(words.startsWith(head!)).toBe(true);
    expect(words.endsWith(tail!)).toBe(true);
    expect(head).toMatch(/word\d+$/);
    expect(tail).toMatch(/^word\d+/);
    expect(length(head!)).toBeLessThanOrEqual(60);
    expect(length(tail!)).toBeLessThanOrEqual(60);
  });

  test("text without spaces is cut between characters, never inside one", () => {
    const family = "👨‍👩‍👧";
    const [head, tail] = of(
      ..."从前有座山，山里有座庙。".repeat(30).split(""),
      ...Array<string>(100).fill(family),
    )!.split(" … ");
    expect(length(head!)).toBe(60);
    expect(tail).toBe(family.repeat(60));
  });
});

import { afterEach, describe, expect, test } from "bun:test";

import { fromBase64 } from "../public/base64.ts";

const native = Object.getOwnPropertyDescriptor(Uint8Array, "fromBase64")!;
const bytes = (...b: number[]) => new Uint8Array(b);

// Every case runs on Bun's own `fromBase64` and on the `atob` fallback, which browsers without it take.
for (const path of ["fromBase64", "atob"] as const) {
  describe(`fromBase64 through ${path}`, () => {
    if (path === "atob") {
      afterEach(() => {
        Object.defineProperty(Uint8Array, "fromBase64", native);
      });
    }
    const decode = (...args: Parameters<typeof fromBase64>) => {
      if (path === "atob") {
        // Taken away to reach the fallback; put back after each test.
        delete (Uint8Array as { fromBase64?: unknown }).fromBase64;
      }
      return fromBase64(...args);
    };

    test("decodes base64, with or without padding and across whitespace", () => {
      expect(decode("AAEC/w==")).toStrictEqual(bytes(0, 1, 2, 255));
      expect(decode("AAEC/w")).toStrictEqual(bytes(0, 1, 2, 255));
      expect(decode("AA EC\n/w==")).toStrictEqual(bytes(0, 1, 2, 255));
      expect(decode("")).toStrictEqual(bytes());
    });

    test("decodes base64url", () => {
      expect(decode("-_8", "base64url")).toStrictEqual(bytes(0xfb, 0xff));
      expect(decode("AAEC_w", "base64url")).toStrictEqual(bytes(0, 1, 2, 255));
    });

    test("refuses the other alphabet and characters outside both", () => {
      expect(() => decode("-_8")).toThrow();
      expect(() => decode("+/8", "base64url")).toThrow();
      expect(() => decode("AA*A")).toThrow();
    });

    test("answers a Uint8Array over its own ArrayBuffer", () => {
      const out = decode("AAEC");
      expect(out).toBeInstanceOf(Uint8Array);
      expect(out.byteOffset).toBe(0);
      expect(out.buffer.byteLength).toBe(3);
    });
  });
}

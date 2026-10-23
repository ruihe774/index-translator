import { describe, expect, test } from "bun:test";

import { cstr, libName, once, pointerOf, slot } from "../src/ffi-util";

describe("ffi-util", () => {
  test("cstr is NUL-terminated UTF-8", () => {
    expect([...cstr("é")]).toStrictEqual([0xc3, 0xa9, 0]);
  });

  test("libName follows the platform and puts the SONAME version after the suffix", () => {
    if (process.platform === "win32") {
      expect(libName("soxr", 0)).toBe("soxr.dll");
    } else {
      expect(libName("llama")).toStartWith("libllama.");
      expect(libName("soxr", 0)).toMatch(/^libsoxr\.\w+\.0$/);
    }
  });

  test("pointerOf reads an out-slot and refuses an address a number cannot hold", () => {
    const out = slot();
    out[0] = 0x7f_00_10_00n;
    expect(pointerOf(out) as number).toBe(0x7f_00_10_00);
    out[0] = 2n ** 60n;
    expect(() => pointerOf(out)).toThrow("cannot hold");
  });

  test("once binds on the first call, answers the same bindings, and refuses another directory", () => {
    let binds = 0;
    const lib = once("libfoo", (dir) => ({ dir, n: ++binds }));
    expect(lib.loaded).toBeUndefined();
    const first = lib.open("/a");
    expect(lib.open("/a")).toBe(first);
    expect(binds).toBe(1);
    expect(lib.loaded).toBe(first);
    expect(() => lib.open("/b")).toThrow("libfoo is already loaded from /a");
  });

  test("a failed bind is retried", () => {
    let attempts = 0;
    const lib = once("libbar", () => {
      if (++attempts === 1) {
        throw new Error("missing");
      }
      return attempts;
    });
    expect(() => lib.open("/a")).toThrow("missing");
    expect(lib.open("/a")).toBe(2);
  });
});

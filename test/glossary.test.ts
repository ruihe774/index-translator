import { describe, expect, test } from "bun:test";

import { parseGlossary } from "../public/glossary";

describe("parseGlossary", () => {
  test("parses valid lines into a source-to-target object", () => {
    expect(parseGlossary("apple = 苹果\nbanana = 香蕉")).toEqual({
      glossary: { apple: "苹果", banana: "香蕉" },
    });
  });

  test("skips blank and whitespace-only lines and trims terms", () => {
    const { glossary, error } = parseGlossary("\n   \n  apple   =   苹果  \n\n\t\nbanana=香蕉\n");
    expect(error).toBeUndefined();
    expect(glossary).toEqual({ apple: "苹果", banana: "香蕉" });
  });

  test("accepts CRLF line endings", () => {
    expect(parseGlossary("apple = 苹果\r\nbanana = 香蕉\r\n")).toEqual({
      glossary: { apple: "苹果", banana: "香蕉" },
    });
  });

  test("splits on the first '=' so the target may contain '='", () => {
    expect(parseGlossary("a = b = c")).toEqual({ glossary: { a: "b = c" } });
  });

  test("reports a line without '=' with its 1-based line number", () => {
    expect(parseGlossary("apple = 苹果\n\nbanana 香蕉")).toEqual({
      glossary: { apple: "苹果" },
      error: { line: 3, kind: "format" },
    });
  });

  test("reports an empty source term", () => {
    expect(parseGlossary("apple = 苹果\n = 香蕉")).toEqual({
      glossary: { apple: "苹果" },
      error: { line: 2, kind: "format" },
    });
  });

  test("reports an empty target term", () => {
    expect(parseGlossary("apple =   ")).toEqual({
      glossary: {},
      error: { line: 1, kind: "format" },
    });
  });

  test("stops at the first bad line and keeps the entries before it", () => {
    const { glossary, error } = parseGlossary("a = 1\nbad\nc = 3\nd");
    expect(glossary).toEqual({ a: "1" });
    expect(error).toEqual({ line: 2, kind: "format" });
  });

  test("keeps __proto__ as an ordinary key", () => {
    const { glossary, error } = parseGlossary("__proto__ = 原型");
    expect(error).toBeUndefined();
    expect(Object.hasOwn(glossary, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(glossary)).toBeNull();
    expect(glossary.__proto__).toBe("原型");
  });

  test("does not treat constructor or toString as existing entries", () => {
    const { glossary, error } = parseGlossary("constructor = 构造\ntoString = 字符串");
    expect(error).toBeUndefined();
    expect(glossary).toEqual({ constructor: "构造", toString: "字符串" });
  });

  test("a null-prototype glossary survives JSON serialization with __proto__ intact", () => {
    const { glossary } = parseGlossary("__proto__ = 原型\napple = 苹果");
    const wire = JSON.stringify({ glossary });
    expect(wire).toBe('{"glossary":{"__proto__":"原型","apple":"苹果"}}');
    const back = JSON.parse(wire) as { glossary: Record<string, string> };
    expect(Object.hasOwn(back.glossary, "__proto__")).toBe(true);
    expect(back.glossary.__proto__).toBe("原型");
  });

  test("reports a repeated source term as a duplicate on the later line", () => {
    expect(parseGlossary("apple = 苹果\nbanana = 香蕉\napple = 苹果果")).toEqual({
      glossary: { apple: "苹果", banana: "香蕉" },
      error: { line: 3, kind: "duplicate", term: "apple" },
    });
  });

  test("treats terms that differ only by surrounding spaces as duplicates", () => {
    const { error } = parseGlossary("apple = 苹果\n  apple  = 苹果");
    expect(error).toEqual({ line: 2, kind: "duplicate", term: "apple" });
  });

  test("a repeated __proto__ is a duplicate, not a silent overwrite", () => {
    const { error } = parseGlossary("__proto__ = 一\n__proto__ = 二");
    expect(error).toEqual({ line: 2, kind: "duplicate", term: "__proto__" });
  });

  test("an empty value gives an empty glossary", () => {
    expect(parseGlossary("")).toEqual({ glossary: {} });
  });
});

import { describe, expect, test } from "bun:test";
import { OutputCleaner } from "../src/app";

const clean = (chunks: string[]) => {
  const c = new OutputCleaner();
  return chunks.map((t) => c.push(t)).join("") + c.flush();
};

/** Every split with one or two cut points, plus one chunk per UTF-16 code unit. */
function partitions(text: string): string[][] {
  const out: string[][] = [[text], text.split("")];
  for (let i = 0; i <= text.length; i++) {
    out.push([text.slice(0, i), text.slice(i)]);
    for (let j = i; j <= text.length; j++) out.push([text.slice(0, i), text.slice(i, j), text.slice(j)]);
  }
  return out;
}

/** Checks the streamed result for every partition: same answer, no retraction, no trailing whitespace. */
function expectEveryPartition(text: string, expected: string) {
  const bad: string[] = [];
  for (const chunks of partitions(text)) {
    const c = new OutputCleaner();
    const outs = chunks.map((t) => c.push(t));
    const tail = c.flush();
    const pushed = outs.join("");
    const ok =
      pushed + tail === expected &&
      expected.startsWith(pushed) &&
      outs.every((o) => o === o.trimEnd());
    if (!ok) bad.push(JSON.stringify(chunks));
  }
  expect(bad.slice(0, 3)).toEqual([]);
}

describe("OutputCleaner across chunk boundaries", () => {
  test("plain text is unchanged", () => {
    expectEveryPartition("Hello, world! It is 2026.", "Hello, world! It is 2026.");
  });

  test("leading and trailing whitespace is trimmed", () => {
    expectEveryPartition("\n  Hello world \t\n\n", "Hello world");
  });

  test("an empty thinking block is dropped", () => {
    expectEveryPartition("<think>\n\n</think>\n\nBody", "Body");
  });

  test("a non-empty thinking block is dropped", () => {
    expectEveryPartition(
      "<think>\nThe user wants French.\nLet me check.\n</think>\n\nBonjour le monde",
      "Bonjour le monde",
    );
  });

  test("whitespace between the thinking block and the body is dropped", () => {
    expectEveryPartition("<think></think> \n\t Body text", "Body text");
  });

  test("a literal think tag in the body is kept", () => {
    expectEveryPartition("Use the <think> tag: <think>x</think> done", "Use the <think> tag: <think>x</think> done");
  });

  test("text starting with <b> is kept", () => {
    expectEveryPartition("<b>Bold</b> start", "<b>Bold</b> start");
  });

  test("text starting with <thin is kept", () => {
    expectEveryPartition("<thin>x</thin>", "<thin>x</thin>");
    expectEveryPartition("<thin", "<thin");
  });

  test("whitespace-only input yields nothing", () => {
    expectEveryPartition(" \n\t\n  ", "");
  });

  test("empty input yields nothing", () => {
    expectEveryPartition("", "");
  });

  test("a thinking block with no body yields nothing", () => {
    expectEveryPartition("<think>\n\n</think>\n\n", "");
    expectEveryPartition("<think>only reasoning</think>", "");
  });

  test("an unterminated thinking block yields nothing", () => {
    expectEveryPartition("<think>\n\nstill thinking, no close", "");
  });

  test("CJK text with a thinking block is cleaned", () => {
    expectEveryPartition("<think>用户要求翻译</think>\n\n你好，世界！这是一个测试。\n", "你好，世界！这是一个测试。");
  });

  test("emoji text keeps its characters and inner whitespace", () => {
    expectEveryPartition(
      "这是一个测试。🙂 Emoji 😀 done \n\n第二段 🚀  ",
      "这是一个测试。🙂 Emoji 😀 done \n\n第二段 🚀",
    );
  });

  test("internal blank lines are preserved", () => {
    expectEveryPartition(
      "Para one.\n\n\nPara two.\n\n\n\nPara three.\n\n",
      "Para one.\n\n\nPara two.\n\n\n\nPara three.",
    );
  });
});

describe("OutputCleaner streaming behaviour", () => {
  test("trailing whitespace is re-emitted only when more text follows", () => {
    const c = new OutputCleaner();
    expect(c.push("Hello  ")).toBe("Hello");
    expect(c.push("world")).toBe("  world");
    expect(c.flush()).toBe("");
  });

  test("trailing whitespace at the very end is dropped", () => {
    const c = new OutputCleaner();
    expect(c.push("Hello  \n")).toBe("Hello");
    expect(c.flush()).toBe("");
    expect(clean(["Hello  \n"])).toBe("Hello");
  });

  test("text is emitted as soon as it is known to be body", () => {
    const c = new OutputCleaner();
    expect(c.push("Hi")).toBe("Hi");
    expect(c.push("!")).toBe("!");
    expect(c.push("<b>")).toBe("<b>");
  });

  test("the thinking block is held back until it closes", () => {
    const c = new OutputCleaner();
    expect(c.push("<think>\n")).toBe("");
    expect(c.push("reasoning")).toBe("");
    expect(c.push("</think>\n\nBody")).toBe("Body");
  });

  test("text that looks like the start of a think tag is held until it resolves", () => {
    const c = new OutputCleaner();
    expect(c.push("<thi")).toBe("");
    expect(c.push("s is text")).toBe("<this is text");
    expect(c.flush()).toBe("");
  });

  test("a held <thin is released by flush", () => {
    const c = new OutputCleaner();
    expect(c.push("<thin")).toBe("");
    expect(c.flush()).toBe("<thin");
  });
});

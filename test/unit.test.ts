import { describe, expect, test } from "bun:test";

import { OutputCleaner } from "../src/app";
import { buildPrompt, languageName } from "../src/prompt";
import { QueueFullError, SlotQueue } from "../src/queue";
import { countLetters, englishEssays, missingParagraphs, repeatedMarkers } from "./fixtures";

describe("buildPrompt", () => {
  test("plain translation without a source language", () => {
    expect(buildPrompt({ text: "  你好，世界！\n", targetLang: "en" })).toBe(
      "请将以下文本翻译为英语，直接输出翻译结果，不要进行任何解释。\n\n你好，世界！",
    );
  });

  test("plain translation with a source language", () => {
    expect(buildPrompt({ text: "Hello", targetLang: "ZH", sourceLang: "en" })).toBe(
      "请将以下英语文本翻译为中文，直接输出翻译结果，不要进行任何解释。\n\nHello",
    );
  });

  test("auto source language is omitted and unknown languages pass through", () => {
    expect(buildPrompt({ text: "Hello", targetLang: "斯瓦希里语", sourceLang: "auto" })).toBe(
      "请将以下文本翻译为斯瓦希里语，直接输出翻译结果，不要进行任何解释。\n\nHello",
    );
    expect(languageName(" Swahili ")).toBe("Swahili");
  });

  test("constrained translation uses the instTrans layout", () => {
    const prompt = buildPrompt({
      text: "碳纤维的好处就是它抗裂缝。",
      targetLang: "en",
      genre: "专栏文章",
      glossary: { 碳纤维: "carbon fiber", 抗裂缝: "crack resistance" },
      hardConstraints: ["保留占位符"],
      softConstraints: ["1. 保持专业严谨的风格\n【软性要求】简洁"],
    });
    expect(prompt).toBe(
      "请将以下专栏文章翻译成英语，并且严格遵循所有约束要求。\n\n" +
        "【源文】\n碳纤维的好处就是它抗裂缝。\n\n" +
        "【约束要求】\n" +
        "1. 【硬性要求】保留占位符\n" +
        "2. 【硬性要求】专名/术语对照: 碳纤维→carbon fiber、抗裂缝→crack resistance\n" +
        "3. 【注意】保持专业严谨的风格\n" +
        "4. 【软性要求】简洁\n\n" +
        "只输出译文，不要有任何额外说明。",
    );
  });

  test("JSON source with a JSON constraint asks for JSON output", () => {
    const prompt = buildPrompt({
      text: '{"message": "您的订单已支付完成。"}',
      targetLang: "en",
      sourceLang: "zh",
      hardConstraints: ["保留源文中的 JSON 格式标记不变"],
    });
    expect(prompt).toStartWith("请将以下中文文本翻译成英语，并且严格遵循所有约束要求。");
    expect(prompt).toEndWith("只输出 JSON，不要有任何额外说明。");
  });
});

describe("OutputCleaner", () => {
  const clean = (chunks: string[]) => {
    const c = new OutputCleaner();
    return chunks.map((t) => c.push(t)).join("") + c.flush();
  };

  test("trims whitespace at both ends but keeps it inside", () => {
    expect(clean(["\n\n", " Hello", " \n", "\nworld", "\n\n"])).toBe("Hello \n\nworld");
  });

  test("drops a leading thinking block split across chunks", () => {
    expect(clean(["<th", "ink>\n\n</thi", "nk>\n\n译文", "。"])).toBe("译文。");
  });

  test("keeps output that merely starts like a tag", () => {
    expect(clean(["<", "b>bold</b>"])).toBe("<b>bold</b>");
    expect(clean(["<thi"])).toBe("<thi");
  });

  test("an unterminated thinking block yields nothing", () => {
    expect(clean(["<think>", "still thinking"])).toBe("");
  });
});

describe("SlotQueue", () => {
  test("runs one at a time in FIFO order and reports positions", async () => {
    const q = new SlotQueue(2);
    const order: string[] = [];
    const positions: number[] = [];

    const a = q.enter();
    const b = q.enter((p) => void positions.push(p));
    const c = q.enter((p) => void positions.push(p * 10));
    void b.ready.then(() => order.push("b"));
    void c.ready.then(() => order.push("c"));

    await a.ready;
    expect(q.running).toBe(true);
    expect(q.depth).toBe(2);
    expect(() => q.enter()).toThrow(QueueFullError);

    a.leave();
    a.leave();
    await b.ready;
    b.leave();
    await c.ready;
    c.leave();

    expect(order).toStrictEqual(["b", "c"]);
    expect(positions).toStrictEqual([1, 20, 10]);
    expect(q.running).toBe(false);
  });

  test("a waiting ticket can leave without disturbing the others", async () => {
    const q = new SlotQueue(2);
    const a = q.enter();
    const b = q.enter();
    const c = q.enter();
    b.leave();
    expect(q.depth).toBe(1);
    a.leave();
    await c.ready;
    c.leave();
    expect(q.running).toBe(false);
  });

  test("a waiting ticket that leaves settles ready as not granted", async () => {
    const q = new SlotQueue(2);
    const a = q.enter();
    const b = q.enter();
    await expect(a.ready).resolves.toBe(true);

    b.leave();
    await expect(b.ready).resolves.toBe(false);
    expect(q.depth).toBe(0);

    a.leave();
    expect(q.running).toBe(false);
  });

  test("leaving a waiting ticket updates the positions of those behind it", () => {
    const q = new SlotQueue(3);
    const positions: Record<"b" | "c" | "d", number[]> = { b: [], c: [], d: [] };
    const a = q.enter();
    const b = q.enter((p) => void positions.b.push(p));
    const c = q.enter((p) => void positions.c.push(p));
    const d = q.enter((p) => void positions.d.push(p));

    b.leave();
    expect(positions).toStrictEqual({ b: [1], c: [2, 1], d: [3, 2] });
    expect(q.depth).toBe(2);

    a.leave();
    c.leave();
    d.leave();
    expect(q.running).toBe(false);
  });
});

describe("fixtures", () => {
  test("the essay document exceeds 16K letters and every paragraph is checkable", async () => {
    const en = await englishEssays();
    expect(countLetters(en.text)).toBeGreaterThanOrEqual(16_000);
    expect(en.markers.every((group) => group.length > 0)).toBe(true);
    const all = en.markers.flat();
    expect(new Set(all).size).toBe(all.length);
  });

  test("omissions and repetitions are detected", async () => {
    const en = await englishEssays();
    const paragraphs = en.text.split("\n\n");
    expect(missingParagraphs(en, en.text)).toStrictEqual([]);
    expect(repeatedMarkers(en, en.text)).toStrictEqual([]);

    expect(missingParagraphs(en, paragraphs.slice(0, -1).join("\n\n"))).toStrictEqual([paragraphs.length]);
    expect(missingParagraphs(en, en.text.replace("38750", "38,750"))).toStrictEqual([]);
    expect(missingParagraphs(en, en.text.replace("38750", "138750"))).toStrictEqual([1]);
    expect(repeatedMarkers(en, en.text + "\n\n" + paragraphs[0])).toStrictEqual(en.markers[0]!);
  });
});

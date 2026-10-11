import { describe, expect, test } from "bun:test";
import {
  CHAT_MODEL,
  DOCUMENT_DIRECTIONS as CLIENT_DIRECTIONS,
  DOCUMENT_MODEL,
  LONG_THRESHOLD_LETTERS,
  countLetters,
  detectSource,
  selectModel,
  type SelectionInput,
} from "../public/select-model";
import { DOCUMENT_DIRECTIONS } from "../src/prompt";

const pick = (over: Partial<SelectionInput>) =>
  selectModel({ text: "Hello", sourceLang: "en", targetLang: "zh", hasOptions: false, choice: "auto", ...over });

describe("countLetters", () => {
  test("counts letters only: spaces, digits and punctuation do not count", () => {
    expect(countLetters("Hello, world! 123 \n\t")).toBe(10);
  });

  test("counts CJK characters and astral letters once each", () => {
    expect(countLetters("你好，世界。")).toBe(4);
    expect(countLetters("𠀀a😀")).toBe(2);
  });
});

describe("selectModel", () => {
  test("the document model's directions match the backend's", () => {
    expect(CLIENT_DIRECTIONS).toEqual(DOCUMENT_DIRECTIONS);
  });

  test("the threshold itself is still the chat model; one letter more switches", () => {
    const at = pick({ text: "a".repeat(LONG_THRESHOLD_LETTERS) });
    expect(at.model).toBe(CHAT_MODEL);
    expect(at.reason).toBe("short");
    const over = pick({ text: "a".repeat(LONG_THRESHOLD_LETTERS + 1) });
    expect(over.model).toBe(DOCUMENT_MODEL);
    expect(over.reason).toBe("long-document");
    expect(over.sourceLang).toBe("en");
  });

  test("spaces and punctuation do not push a text over the threshold", () => {
    const text = ("a".repeat(10) + ", ").repeat(LONG_THRESHOLD_LETTERS / 10);
    expect(text.length).toBeGreaterThan(LONG_THRESHOLD_LETTERS);
    expect(pick({ text }).model).toBe(CHAT_MODEL);
  });

  test("surrounding whitespace is ignored", () => {
    expect(pick({ text: "  " + "a".repeat(LONG_THRESHOLD_LETTERS) + "\n\n\n" }).model).toBe(CHAT_MODEL);
  });

  test("long text in an unsupported direction stays on the chat model with a warning", () => {
    const s = pick({ text: "a".repeat(20_000), sourceLang: "en", targetLang: "fr" });
    expect(s).toMatchObject({ model: CHAT_MODEL, reason: "long-unsupported-direction", warn: true });
  });

  test("long text with glossary or constraints stays on the chat model with a warning", () => {
    const s = pick({ text: "a".repeat(20_000), hasOptions: true });
    expect(s).toMatchObject({ model: CHAT_MODEL, reason: "long-options", warn: true });
  });

  test("auto source: a detected Chinese source selects the document model and is sent explicitly", () => {
    const s = pick({ text: "你好世界。".repeat(4000), sourceLang: "auto", targetLang: "en" });
    expect(s).toMatchObject({ model: DOCUMENT_MODEL, reason: "long-document", sourceLang: "zh" });
  });

  test("auto source that cannot be determined is not guessed", () => {
    const s = pick({ text: "Bonjour le monde. ".repeat(2000), sourceLang: "auto", targetLang: "zh" });
    expect(s).toMatchObject({ model: CHAT_MODEL, reason: "long-unknown-source", warn: true });
  });

  test("auto source on the chat model leaves the source out for the model to detect", () => {
    expect(pick({ sourceLang: "auto" }).sourceLang).toBeUndefined();
  });

  test("manual choice overrides the length rule", () => {
    expect(pick({ text: "a".repeat(20_000), choice: CHAT_MODEL })).toMatchObject({ model: CHAT_MODEL, reason: "manual", warn: true });
    expect(pick({ choice: DOCUMENT_MODEL })).toMatchObject({ model: DOCUMENT_MODEL, reason: "manual", warn: false });
  });

  test("manually choosing the document model for something it rejects is flagged", () => {
    expect(pick({ choice: DOCUMENT_MODEL, targetLang: "fr" }).reason).toBe("manual-document-unusable");
    expect(pick({ choice: DOCUMENT_MODEL, hasOptions: true }).reason).toBe("manual-document-unusable");
    expect(pick({ choice: DOCUMENT_MODEL, sourceLang: "auto", text: "Bonjour" }).reason).toBe("manual-document-unusable");
  });

  test("manual chat choice warns only above the threshold", () => {
    expect(pick({ choice: CHAT_MODEL, text: "a".repeat(LONG_THRESHOLD_LETTERS) })).toMatchObject({
      model: CHAT_MODEL,
      reason: "manual",
      warn: false,
    });
    expect(pick({ choice: CHAT_MODEL, text: "a".repeat(LONG_THRESHOLD_LETTERS + 1) })).toMatchObject({
      model: CHAT_MODEL,
      reason: "manual",
      warn: true,
    });
  });

  test("manual chat choice with glossary or constraints is not flagged when the text is short", () => {
    expect(pick({ choice: CHAT_MODEL, hasOptions: true })).toMatchObject({ model: CHAT_MODEL, reason: "manual", warn: false });
  });

  test("manual chat choice sends an explicit source language", () => {
    expect(pick({ choice: CHAT_MODEL, sourceLang: "en", targetLang: "zh" }).sourceLang).toBe("en");
    expect(pick({ choice: CHAT_MODEL, sourceLang: "zh", text: "a".repeat(20_000) }).sourceLang).toBe("zh");
  });

  test("an explicit source language is sent on the chat model too", () => {
    expect(pick({ sourceLang: "fr", targetLang: "en" }).sourceLang).toBe("fr");
    expect(pick({ sourceLang: "zh", targetLang: "en" })).toMatchObject({ model: CHAT_MODEL, sourceLang: "zh" });
  });

  test("same source and target language is not a document direction", () => {
    expect(pick({ text: "a".repeat(20_000), sourceLang: "en", targetLang: "en" })).toMatchObject({
      model: CHAT_MODEL,
      reason: "long-unsupported-direction",
      sourceLang: "en",
      warn: true,
    });
    expect(pick({ text: "你好世界。".repeat(4000), sourceLang: "auto", targetLang: "zh" })).toMatchObject({
      model: CHAT_MODEL,
      reason: "long-unsupported-direction",
      warn: true,
    });
    expect(pick({ text: "Hello", sourceLang: "en", targetLang: "en" })).toMatchObject({ model: CHAT_MODEL, reason: "short", warn: false });
    expect(pick({ choice: DOCUMENT_MODEL, sourceLang: "en", targetLang: "en" }).reason).toBe("manual-document-unusable");
  });

  test("upper-case language codes select the same model as lower-case ones", () => {
    expect(pick({ text: "a".repeat(20_000), sourceLang: "EN", targetLang: "ZH" })).toMatchObject({
      model: DOCUMENT_MODEL,
      reason: "long-document",
      sourceLang: "en",
    });
    expect(pick({ text: "你好世界。".repeat(4000), sourceLang: "ZH", targetLang: "EN" })).toMatchObject({
      model: DOCUMENT_MODEL,
      reason: "long-document",
      sourceLang: "zh",
    });
    expect(pick({ text: "a".repeat(20_000), sourceLang: "EN", targetLang: "FR" })).toMatchObject({
      model: CHAT_MODEL,
      reason: "long-unsupported-direction",
    });
  });

  test("an upper-case or padded AUTO is detected like auto, as the backend does", () => {
    expect(pick({ text: "你好世界。".repeat(4000), sourceLang: "AUTO", targetLang: "en" })).toMatchObject({
      model: DOCUMENT_MODEL,
      reason: "long-document",
      sourceLang: "zh",
    });
    expect(pick({ sourceLang: " Auto " }).sourceLang).toBeUndefined();
  });
});

describe("detectSource", () => {
  test("Chinese, Japanese and English", () => {
    expect(detectSource("今天天气很好，我们去公园散步。")).toBe("zh");
    expect(detectSource("今日はいい天気ですね。公園へ行きましょう。")).toBe("ja");
    expect(detectSource("The town library reopened last month after a renovation that took far longer than planned.")).toBe("en");
  });

  test("other Latin-script languages and empty input are not guessed", () => {
    expect(detectSource("Le conseil municipal a rouvert la bibliothèque après des travaux.")).toBeUndefined();
    expect(detectSource("El ayuntamiento reabrió la biblioteca después de las obras.")).toBeUndefined();
    expect(detectSource("1234 !!!")).toBeUndefined();
  });

  test("kana at 5 percent: 5 of 100 letters is not Japanese, 6 of 100 is", () => {
    expect(detectSource("あ".repeat(5) + "a".repeat(95))).toBeUndefined();
    expect(detectSource("あ".repeat(6) + "a".repeat(94))).toBe("ja");
  });

  test("Han at 30 percent: 30 of 100 letters is not Chinese, 31 of 100 is", () => {
    expect(detectSource("中".repeat(30) + "a".repeat(70))).toBeUndefined();
    expect(detectSource("中".repeat(31) + "a".repeat(69))).toBe("zh");
  });

  test("ASCII at 98 percent: 97 of 100 letters is not English, 98 of 100 can be", () => {
    const common = "the ".repeat(32);
    expect(detectSource(common + "a" + "é".repeat(3))).toBeUndefined();
    expect(detectSource(common + "ab" + "é".repeat(2))).toBe("en");
  });

  test("common English words at 10 percent: 10 of 100 words is not English, 11 of 100 is", () => {
    expect(detectSource("the ".repeat(10) + "zebra ".repeat(90))).toBeUndefined();
    expect(detectSource("the ".repeat(11) + "zebra ".repeat(89))).toBe("en");
  });

  test("traditional Chinese is Chinese", () => {
    expect(detectSource("這個圖書館在上個月重新開放，經過了比計劃長得多的翻修。")).toBe("zh");
  });

  test("kanji-only Japanese is detected as Chinese, because it has no kana", () => {
    expect(detectSource("東京国立博物館上野公園")).toBe("zh");
  });

  test("Chinese with a few English words is Chinese; English with a little Chinese is not guessed", () => {
    expect(detectSource("今天天气很好，我们去 park 散步。")).toBe("zh");
    expect(detectSource("The library 图书馆 reopened last month 重新开放 after the renovation")).toBeUndefined();
  });

  test("only the first 20,000 letters decide, while countLetters still counts all of them", () => {
    const head = "the ".repeat(7000); // 21,000 letters, all English
    const text = head + "你".repeat(4_000_000);
    expect(detectSource(text)).toBe("en");
    expect(countLetters(text)).toBe(21_000 + 4_000_000);
  });
});

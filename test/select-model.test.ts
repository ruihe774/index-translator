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
});

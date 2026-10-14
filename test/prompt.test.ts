import { describe, expect, test } from "bun:test";

import { buildDocumentPrompt, DOCUMENT_DIRECTIONS } from "../src/prompt";

describe("buildDocumentPrompt", () => {
  test("has a template for each supported direction", () => {
    expect(DOCUMENT_DIRECTIONS).toStrictEqual(["zh-en", "en-zh", "zh-ja", "ja-zh"]);
    for (const direction of DOCUMENT_DIRECTIONS) {
      const prompt = buildDocumentPrompt(direction, "text");
      expect(prompt).toEndWith("【源文】\n\ntext");
      expect(prompt).not.toContain("（在这里放入");
    }
  });

  test("names the source and target language in the instruction", () => {
    expect(buildDocumentPrompt("en-zh", "x")).toStartWith("请将以下英文小说翻译成中文");
    expect(buildDocumentPrompt("zh-ja", "x")).toStartWith("请将以下中文小说翻译成日语");
  });

  test("keeps dollar signs in the document literal", () => {
    expect(buildDocumentPrompt("en-zh", "Price: $& and $1")).toEndWith("【源文】\n\nPrice: $& and $1");
  });

  test("trims the document", () => {
    expect(buildDocumentPrompt("en-zh", "  body \n")).toEndWith("【源文】\n\nbody");
  });

  test("rejects a direction without a template", () => {
    expect(() => buildDocumentPrompt("en-fr", "x")).toThrow("no document template");
  });
});

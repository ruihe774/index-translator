import { describe, expect, test } from "bun:test";
import { buildRequest, type FormValues, glossaryMessage, hasOptions, lines } from "../public/request";
import { CHAT_MODEL, DOCUMENT_MODEL } from "../public/select-model";

const form = (over: Partial<FormValues> = {}): FormValues => ({
  text: "hello",
  targetLang: "zh",
  glossary: "",
  hard: "",
  soft: "",
  genre: "",
  ...over,
});
const bodyOf = (r: ReturnType<typeof buildRequest>) => {
  if (!("body" in r)) throw new Error("expected a body");
  return r.body;
};

describe("hasOptions", () => {
  test("glossary, hard and soft constraints count; blanks and genre do not", () => {
    expect(hasOptions({ glossary: "a=b", hard: "", soft: "" })).toBe(true);
    expect(hasOptions({ glossary: "", hard: "x", soft: "" })).toBe(true);
    expect(hasOptions({ glossary: "", hard: "", soft: "x" })).toBe(true);
    expect(hasOptions({ glossary: " \n ", hard: "  ", soft: "\t" })).toBe(false);
    expect(hasOptions({ glossary: "", hard: "", soft: "", genre: "novel" } as never)).toBe(false);
  });
});

describe("lines", () => {
  test("trims and drops blank lines", () => {
    expect(lines(" a \n\n  \nb\n")).toEqual(["a", "b"]);
    expect(lines("")).toEqual([]);
  });
});

describe("buildRequest", () => {
  test("the minimal chat request streams and has no options", () => {
    expect(bodyOf(buildRequest(CHAT_MODEL, undefined, form()))).toEqual({
      model: CHAT_MODEL,
      text: "hello",
      target_lang: "zh",
      stream: true,
    });
  });
  test("source_lang is sent only when the selection has one", () => {
    expect(bodyOf(buildRequest(CHAT_MODEL, undefined, form()))).not.toHaveProperty("source_lang");
    expect(bodyOf(buildRequest(DOCUMENT_MODEL, "zh", form({ targetLang: "en" })))).toMatchObject({
      source_lang: "zh",
      target_lang: "en",
    });
    expect(bodyOf(buildRequest(CHAT_MODEL, "en", form()))).toMatchObject({ source_lang: "en" });
  });
  test("the text is sent untrimmed", () => {
    expect(bodyOf(buildRequest(CHAT_MODEL, undefined, form({ text: "  hi\n" }))).text).toBe("  hi\n");
  });
  test("glossary, constraints and genre go to the chat model", () => {
    const body = bodyOf(
      buildRequest(
        CHAT_MODEL,
        undefined,
        form({ glossary: "cat = 猫\n dog=犬", hard: "keep names\n", soft: " formal \n\nshort", genre: " novel " }),
      ),
    );
    expect(JSON.parse(JSON.stringify(body))).toEqual({
      model: CHAT_MODEL,
      text: "hello",
      target_lang: "zh",
      stream: true,
      glossary: { cat: "猫", dog: "犬" },
      hard_constraints: ["keep names"],
      soft_constraints: ["formal", "short"],
      genre: "novel",
    });
  });
  test("a lone genre is not sent, with each kind of option it is", () => {
    expect(bodyOf(buildRequest(CHAT_MODEL, undefined, form({ genre: "novel" })))).not.toHaveProperty("genre");
    for (const extra of [{ glossary: "a=b" }, { hard: "x" }, { soft: "x" }]) {
      expect(bodyOf(buildRequest(CHAT_MODEL, undefined, form({ genre: "novel", ...extra })))).toHaveProperty(
        "genre",
        "novel",
      );
    }
  });
  test("a blank glossary adds no glossary key", () => {
    expect(bodyOf(buildRequest(CHAT_MODEL, undefined, form({ glossary: " \n" })))).not.toHaveProperty("glossary");
  });
  test("the document model never gets options, even malformed ones", () => {
    const r = buildRequest(
      DOCUMENT_MODEL,
      "zh",
      form({ targetLang: "en", glossary: "broken", hard: "x", soft: "y", genre: "z" }),
    );
    expect(bodyOf(r)).toEqual({
      model: DOCUMENT_MODEL,
      text: "hello",
      target_lang: "en",
      stream: true,
      source_lang: "zh",
    });
  });
  test("a malformed glossary stops the request and reports the line", () => {
    expect(buildRequest(CHAT_MODEL, undefined, form({ glossary: "a=b\nno equals" }))).toEqual({
      glossaryProblem: { line: 2, kind: "format" },
    });
    expect(buildRequest(CHAT_MODEL, undefined, form({ glossary: "a=b\na=c" }))).toEqual({
      glossaryProblem: { line: 2, kind: "duplicate", term: "a" },
    });
  });
  test("__proto__ stays a glossary term in the serialized body", () => {
    const body = bodyOf(buildRequest(CHAT_MODEL, undefined, form({ glossary: "__proto__ = x" })));
    expect(JSON.parse(JSON.stringify(body)).glossary).toEqual(JSON.parse('{"__proto__":"x"}'));
    expect(Object.keys(JSON.parse(JSON.stringify(body)).glossary)).toEqual(["__proto__"]);
  });
});

describe("glossaryMessage", () => {
  test("format and duplicate problems", () => {
    expect(glossaryMessage({ line: 3, kind: "format" })).toBe(
      "Glossary line 3 must look like: source term = target term.",
    );
    expect(glossaryMessage({ line: 4, kind: "duplicate", term: "cat" })).toBe(
      'Glossary line 4 repeats the source term "cat". Each source term may appear only once.',
    );
  });
});

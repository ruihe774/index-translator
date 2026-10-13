import { describe, expect, test } from "bun:test";

import {
  adviceMessage,
  healthMessage,
  imageAdviceMessage,
  INTERRUPTED_NOTE,
  interruption,
  metaLine,
  modelLabel,
  resultNotes,
  SAME_LANGUAGE_WARNING,
  sameLanguage,
  seconds,
  selectionMessage,
  STOPPED_NOTE,
} from "../public/messages";
import type { ResultContext } from "../public/messages";
import { CHAT_MODEL, DOCUMENT_MODEL, LONG_THRESHOLD_LETTERS } from "../public/select-model";
import type { Reason, Selection } from "../public/select-model";

const selection = (model: Selection["model"], reason: Reason, letters = 100): Selection =>
  ({ model, reason, letters }) as Selection;

describe("selectionMessage", () => {
  const cases: [Reason, Selection["model"], boolean, RegExp][] = [
    ["short", CHAT_MODEL, false, /^Model: Index-Translate-9B\. The text is within 11,000 letters/],
    ["long-document", DOCUMENT_MODEL, false, /^Model: Index-NativeLong-9B\. .*whole-document model is used/],
    [
      "long-unsupported-direction",
      CHAT_MODEL,
      true,
      /^Warning: .*only translates Chinese to or from English or Japanese/,
    ],
    ["long-unknown-source", CHAT_MODEL, true, /^Warning: .*could not be determined.*"From"/],
    ["long-options", CHAT_MODEL, true, /^Warning: .*glossary, constraints or genre need Index-Translate-9B/],
    ["manual-document-unusable", DOCUMENT_MODEL, true, /^Warning: Index-NativeLong-9B cannot translate this/],
  ];
  for (const [reason, model, warn, pattern] of cases) {
    test(reason, () => {
      const m = selectionMessage(selection(model, reason, LONG_THRESHOLD_LETTERS + 1));
      expect(m.warn).toBe(warn);
      expect(m.text).toMatch(pattern);
    });
  }

  test("manual: only a chat model on a long text is a warning", () => {
    const over = LONG_THRESHOLD_LETTERS + 1;
    expect(selectionMessage(selection(CHAT_MODEL, "manual", over))).toMatchObject({ warn: true });
    expect(selectionMessage(selection(CHAT_MODEL, "manual", over)).text).toContain("you chose Index-Translate-9B");
    expect(selectionMessage(selection(CHAT_MODEL, "manual", LONG_THRESHOLD_LETTERS))).toEqual({
      text: "Model: Index-Translate-9B, as you chose.",
      warn: false,
    });
    expect(selectionMessage(selection(DOCUMENT_MODEL, "manual", over))).toEqual({
      text: "Model: Index-NativeLong-9B, as you chose.",
      warn: false,
    });
  });
});

describe("sameLanguage", () => {
  test("an explicit equal pair only", () => {
    expect(sameLanguage("en", "en")).toBe(true);
    expect(sameLanguage("en", "zh")).toBe(false);
    expect(sameLanguage("auto", "auto")).toBe(false);
    expect(sameLanguage("auto", "en")).toBe(false);
    expect(sameLanguage("", "")).toBe(false);
  });
});

describe("adviceMessage", () => {
  const base = selection(CHAT_MODEL, "short");

  test("nothing to warn about: empty, the model sentence is not repeated", () => {
    expect(adviceMessage(base, "auto", "en", "")).toBe("");
    expect(adviceMessage(selection(CHAT_MODEL, "manual"), "auto", "en", "")).toBe("");
  });
  test("the same-language warning", () => {
    expect(adviceMessage(base, "en", "en", "")).toBe(SAME_LANGUAGE_WARNING);
  });
  test("the language note", () => {
    expect(adviceMessage(base, "auto", "en", "Only three languages.")).toBe("Only three languages.");
  });
  test("a selection warning, the same-language warning and the note keep their order", () => {
    const warned = selection(CHAT_MODEL, "long-options", LONG_THRESHOLD_LETTERS + 1);
    expect(adviceMessage(warned, "en", "en", "Note.")).toBe(
      `${selectionMessage(warned).text} ${SAME_LANGUAGE_WARNING} Note.`,
    );
  });
});

describe("imageAdviceMessage", () => {
  test("nothing to say for the chat model or Automatic", () => {
    expect(imageAdviceMessage(false, "auto", "en", "")).toBe("");
  });
  test("the document model was chosen: the chat model is used, and the warnings keep their order", () => {
    expect(imageAdviceMessage(true, "en", "en", "Note.")).toBe(
      `Warning: Index-NativeLong-9B does not translate images. Index-Translate-9B will be used. ${SAME_LANGUAGE_WARNING} Note.`,
    );
  });
});

describe("healthMessage", () => {
  const queue = { running: false, waiting: 0 };
  test("ready with and without a model, and with a queue", () => {
    expect(healthMessage({ status: "ready", model: null, queue })).toEqual({ text: "Engine ready.", loading: false });
    expect(healthMessage({ status: "ready", model: CHAT_MODEL, queue }).text).toBe(
      "Engine ready, Index-Translate-9B loaded.",
    );
    expect(healthMessage({ status: "ready", model: "other-model", queue: { running: true, waiting: 2 } }).text).toBe(
      "Engine ready, other-model loaded. 2 waiting in the queue.",
    );
  });
  test("loading is the only state that keeps polling", () => {
    expect(healthMessage({ status: "loading", model: null, queue })).toEqual({
      text: "Engine loading a model…",
      loading: true,
    });
    expect(healthMessage({ status: "error", error: "bad file", model: null, queue })).toEqual({
      text: "Engine error: bad file.",
      loading: false,
    });
    expect(healthMessage({ status: "idle", model: null, queue })).toEqual({ text: "Engine idle.", loading: false });
  });
});

describe("seconds", () => {
  test("one decimal under 10 s, none from 10 s", () => {
    expect(seconds(0)).toBe("0.0 s");
    expect(seconds(1234)).toBe("1.2 s");
    expect(seconds(9949)).toBe("9.9 s");
    expect(seconds(10_000)).toBe("10 s");
    expect(seconds(10_499)).toBe("10 s");
    expect(seconds(123_456)).toBe("123 s");
  });
});

describe("resultNotes", () => {
  const ctx = {
    source: "一\n二\n三",
    translation: "1\n2\n3",
    model: CHAT_MODEL,
    sourceLang: undefined,
    targetLang: "en",
  } as const;

  test("a clean result has no notes", () => {
    expect(resultNotes({ finish_reason: "stop" }, ctx)).toEqual([]);
  });
  test("finish_reason length is reported first", () => {
    const notes = resultNotes({ finish_reason: "length" }, ctx);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("reached the output limit");
  });
  test("lost lines are reported", () => {
    const notes = resultNotes({ finish_reason: "stop" }, { ...ctx, translation: "1\n2" });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("3 lines");
  });
  test("the Chinese to English document-model warning needs all three conditions", () => {
    const doc = { ...ctx, model: DOCUMENT_MODEL, sourceLang: "zh" } as const;
    expect(resultNotes({ finish_reason: "stop" }, doc)[0]).toContain("Long Chinese-to-English output");
    expect(resultNotes({ finish_reason: "stop" }, { ...doc, model: CHAT_MODEL })).toEqual([]);
    expect(resultNotes({ finish_reason: "stop" }, { ...doc, sourceLang: "ja" })).toEqual([]);
    expect(resultNotes({ finish_reason: "stop" }, { ...doc, targetLang: "ja" })).toEqual([]);
  });
  test("all three together keep their order", () => {
    const notes = resultNotes(
      { finish_reason: "length" },
      { ...ctx, translation: "1", model: DOCUMENT_MODEL, sourceLang: "zh" },
    );
    expect(notes).toHaveLength(3);
    expect(notes[0]).toContain("output limit");
    expect(notes[1]).toContain("lines");
    expect(notes[2]).toContain("Chinese-to-English");
  });
});

describe("resultNotes for an image", () => {
  test("there is no source to compare paragraphs with; a cut-off translation is still said", () => {
    const ctx: ResultContext = {
      source: null,
      translation: "One.\n\nTwo.",
      model: CHAT_MODEL,
      sourceLang: undefined,
      targetLang: "en",
    };
    expect(resultNotes({ finish_reason: "stop" }, ctx)).toEqual([]);
    expect(resultNotes({ finish_reason: "length" }, ctx)).toHaveLength(1);
  });
});

describe("metaLine", () => {
  test("labels the model and adds queue and generation time", () => {
    const done = {
      finish_reason: "stop",
      usage: { prompt_tokens: 1234, completion_tokens: 56 },
      timings: { queue_ms: 500, generation_ms: 1000 },
    };
    expect(metaLine(CHAT_MODEL, done)).toBe("Index-Translate-9B · 1,234 prompt tokens · 56 generated · 1.5 s");
  });
});

describe("interruption", () => {
  test("nothing was received: no note, no Copy button", () => {
    expect(interruption("", true)).toEqual({ note: null, showCopy: false });
    expect(interruption("", false)).toEqual({ note: null, showCopy: false });
  });
  test("partial text is kept with Copy and a note that says why", () => {
    expect(interruption("partial", true)).toEqual({ note: STOPPED_NOTE, showCopy: true });
    expect(interruption("partial", false)).toEqual({ note: INTERRUPTED_NOTE, showCopy: true });
  });
});

describe("modelLabel", () => {
  test("known ids are labelled, unknown ids pass through", () => {
    expect(modelLabel(DOCUMENT_MODEL)).toBe("Index-NativeLong-9B");
    expect(modelLabel("x")).toBe("x");
  });
});

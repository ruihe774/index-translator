import { expect, test } from "bun:test";

import { linkProblem, linkPrompt, linkReference } from "../public/links.ts";
import { alignBlocks, alignFromPairs } from "../public/paragraphs.ts";

const source = "[A](https://a.example)\n\n[B](https://b.example)\n\nplain";

test("a target in the matching paragraph passes", () => {
  const out = "[甲](https://a.example)\n\n[乙](https://b.example)\n\n文本";
  const ref = linkReference(source, alignBlocks(source, out));
  expect(linkProblem(ref, "https://a.example", 0)).toBeNull();
  expect(linkProblem(ref, "https://b.example", 2)).toBeNull();
});

test("a target from another paragraph is a mismatch", () => {
  const out = "[甲](https://b.example)\n\n[乙](https://b.example)\n\n文本";
  const ref = linkReference(source, alignBlocks(source, out));
  expect(linkProblem(ref, "https://b.example", 0)).toBe("mismatch");
});

test("a target absent from the source is missing", () => {
  const out = "[甲](https://evil.example)\n\n乙\n\n文本";
  const ref = linkReference(source, alignBlocks(source, out));
  expect(linkProblem(ref, "https://evil.example", 0)).toBe("missing");
});

test("the confirm dialog words paired and unpaired links differently", () => {
  const paired = linkPrompt(true);
  const unpaired = linkPrompt(false);
  expect(paired.title).not.toBe(unpaired.title);
  expect(paired.message).not.toBe(unpaired.message);
  expect(paired.open).not.toBe(unpaired.open);
});

test("blocks matched by POST /align: a merged block pairs with both sources, an added one with none", () => {
  const out = "[甲](https://a.example) [乙](https://b.example)\n\n文本\n\n[又](https://a.example)";
  const pair = (s: number[], t: number[]) => ({ source: s, target: t, similarity: 0.9 });
  const ref = linkReference(source, alignFromPairs(source, out, [pair([0, 1], [0]), pair([2], [1]), pair([], [2])]));
  expect(linkProblem(ref, "https://a.example", 0)).toBeNull();
  expect(linkProblem(ref, "https://b.example", 0)).toBeNull();
  expect(linkProblem(ref, "https://a.example", 4)).toBe("mismatch");
});

test("failed paragraph matching marks known targets as mismatch", () => {
  const out = "[甲](https://a.example)";
  const ref = linkReference(source, alignBlocks(source, out));
  expect(ref.alignment).toBeNull();
  expect(linkProblem(ref, "https://a.example", 0)).toBe("mismatch");
});

import { expect, test } from "bun:test";
import { linkProblem, linkReference } from "../public/links.ts";
import { alignBlocks } from "../public/paragraphs.ts";

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

test("failed paragraph matching marks known targets as mismatch", () => {
  const out = "[甲](https://a.example)";
  const ref = linkReference(source, alignBlocks(source, out));
  expect(ref.alignment).toBeNull();
  expect(linkProblem(ref, "https://a.example", 0)).toBe("mismatch");
});

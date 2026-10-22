// Link check for rendered Markdown output. A translation may rewrite, invent or misplace a link
// target; the targets a link may have are the ones in the source. Pure parts are testable without a
// DOM; `checkLinks` applies the verdicts to the rendered output.
//
// - "missing": the target occurs nowhere in the source. The link is disabled.
// - "mismatch": the target occurs in the source but not in the source blocks that the output block
//   was matched to, or the block has no counterpart, or the blocks could not be matched at all. The
//   link is marked, not disabled.

import { type Block, type Inline, parseLines } from "./markdown.ts";
import { type Alignment, counterpart } from "./paragraphs.ts";

export type LinkProblem = "missing" | "mismatch";

export interface LinkReference {
  /** The source text; a target found in it, however written, is not missing. */
  text: string;
  /** Every target of the parsed source links, per top-level block start line. */
  byLine: Map<number, Set<string>>;
  /** Block alignment of source and output, or null while the blocks are not matched. */
  alignment: Alignment | null;
}

function inlineHrefs(nodes: Inline[], into: Set<string>) {
  for (const n of nodes) {
    if (n.type === "link" || n.type === "image") {
      into.add(n.href);
    }
    if ("children" in n) {
      inlineHrefs(n.children, into);
    }
  }
}

function blockHrefs(b: Block, into: Set<string>) {
  switch (b.type) {
    case "heading":
    case "paragraph": {
      inlineHrefs(b.children, into);
      break;
    }
    case "quote": {
      for (const c of b.children) {
        blockHrefs(c, into);
      }
      break;
    }
    case "list": {
      for (const item of b.items) {
        for (const c of item.children) {
          blockHrefs(c, into);
        }
      }
      break;
    }
    case "table": {
      for (const cell of [...b.head, ...b.rows.flat()]) {
        inlineHrefs(cell, into);
      }
      break;
    }
    // no default
  }
}

export function linkReference(source: string, alignment: Alignment | null): LinkReference {
  const byLine = new Map<number, Set<string>>();
  for (const { block, line } of parseLines(source.split("\n"))) {
    const set = byLine.get(line) ?? new Set<string>();
    blockHrefs(block, set);
    byLine.set(line, set);
  }
  return { text: source, byLine, alignment };
}

/**
 * What is wrong with a link in the output, or null. `outputLine` is the first line of the output's
 * top-level block that holds the link.
 */
export function linkProblem(ref: LinkReference, href: string, outputLine: number): LinkProblem | null {
  if (!ref.text.includes(href)) {
    return "missing";
  }
  const match = ref.alignment && counterpart(ref.alignment, "output", outputLine);
  if (!match) {
    return "mismatch";
  }
  const { from, to } = match.other;
  for (const [line, hrefs] of ref.byLine) {
    if (line >= from && line < to && hrefs.has(href)) {
      return null;
    }
  }
  return "mismatch";
}

export const LINK_NOTE: Record<LinkProblem, string> = {
  missing: "This link target is not in the source text; the link is disabled.",
  mismatch:
    "This link target differs from the source link in the matching paragraph, or the paragraphs could not be matched.",
};

export interface LinkPrompt {
  title: string;
  message: string;
  /** Label of the confirming button. */
  open: string;
}

/** What the confirm dialog says before a link is opened; `paired` when the check found its target in the source. */
export function linkPrompt(paired: boolean): LinkPrompt {
  return paired
    ? {
        title: "Open this link?",
        message: "The target matches a link in the matching paragraph of the source. It opens in a new tab.",
        open: "Open link",
      }
    : {
        title: "Open this unverified link?",
        message:
          "This link could not be matched with the source: the translation may have changed its target, the paragraphs could not be paired, or the check has not run. Open it only if you trust the address. It opens in a new tab.",
        open: "Open anyway",
      };
}

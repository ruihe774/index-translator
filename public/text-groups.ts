// The text a rendered view shows, cut into groups: one per block that holds text (a paragraph, a
// heading, a list item, a table cell, a line of plain text), so that a sentence never runs across two
// of them (`sentence-spans.ts` finds the sentences of a group). A group's text is its text nodes
// joined, a `<br>` written as a newline; code blocks, the notes only a screen reader gets and a subtitle
// cue's number and time are left out.

import type { Run } from "./sentence-spans.ts";

export interface TextGroup {
  text: string;
  /** The text nodes, each with the part of `text` it holds. */
  runs: Run<Text>[];
}

/** Blocks that hold text of their own; the text of anything else belongs to the one around it. */
const BLOCK = "p, h1, h2, h3, h4, h5, h6, li, th, td, blockquote";
/** What is not text of the page: code blocks, the notes added to links for screen readers, cue numbers and times. */
const SKIPPED = "pre, .sr-only, .cue-meta";

/** The block that `node` belongs to: its nearest block, else the top-level element of `view` around it. */
function blockOf(node: Node, view: HTMLElement): Element | null {
  const parent = node.parentElement;
  const block = parent?.closest(BLOCK);
  if (block && view.contains(block)) {
    return block;
  }
  let top = parent;
  while (top && top.parentElement !== view) {
    top = top.parentElement;
  }
  return top;
}

/** The groups of `view`, in reading order. */
export function collectGroups(view: HTMLElement): TextGroup[] {
  const groups = new Map<Element, TextGroup>();
  const walker = document.createTreeWalker(view, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n instanceof Element && n.matches(SKIPPED) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const isBreak = node instanceof HTMLBRElement;
    if (!isBreak && !(node instanceof Text)) {
      continue;
    }
    const block = blockOf(node, view);
    if (!block) {
      continue;
    }
    let group = groups.get(block);
    if (!group) {
      group = { text: "", runs: [] };
      groups.set(block, group);
    }
    if (node instanceof Text) {
      group.runs.push({ node, start: group.text.length, end: group.text.length + node.data.length });
      group.text += node.data;
    } else {
      group.text += "\n";
    }
  }
  for (const group of groups.values()) {
    // A line of plain text holds its own newline.
    group.text = group.text.replace(/\n$/, "");
  }
  return [...groups.values()].filter((g) => g.runs.length > 0);
}

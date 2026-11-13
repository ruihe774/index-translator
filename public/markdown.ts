// A small Markdown parser for the translation output, and the test that decides whether to use it.
// Pure: it turns text into a block tree and does no DOM work, so bun test can import it; the page
// builds elements from the tree in `markdown-dom.ts`.
//
// It covers what translated documents and model output use: ATX and setext headings, paragraphs,
// fenced code, block quotes, bullet, ordered and task lists, thematic breaks, GFM tables and display
// equations (`$$`); inline code, equations (`$…$`, `$$…$$`), emphasis, strong, strikethrough, inline
// links, images (shown as links), autolinks and a few attribute-less inline HTML tags (`<sup>`,
// `<sub>`, `<u>`, `<mark>`, `<kbd>`, `<small>`, `<br>` and the `<b>`/`<i>`/`<s>` aliases).
// Deliberately left out: all other raw HTML (shown as text), indented code blocks (indented prose
// stays prose), reference links and entity references. A single newline inside a paragraph is kept
// as a line break, as in the plain-text view. Every other CommonMark spec example passes; see
// docs/markdown-conformance.md and `bun scripts/commonmark.ts`.
//
// Streaming: a block, once a later line has started another block, never changes. `MarkdownStream`
// relies on this to hand finished blocks out once and re-parse only the open tail.

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "em" | "strong" | "del" | "sup" | "sub" | "u" | "mark" | "kbd" | "small"; children: Inline[] }
  | { type: "link"; href: string; title: string; children: Inline[] }
  | { type: "image"; href: string; title: string; alt: string }
  /** TeX, without its dollar signs; `display` for `$$…$$`. */
  | { type: "math"; tex: string; display: boolean }
  | { type: "br" };

export type Align = "left" | "center" | "right" | null;

export interface ListItem {
  /** null for an ordinary item, else whether the task box is checked. */
  task: boolean | null;
  children: Block[];
}

export type Block =
  | { type: "heading"; level: number; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | { type: "code"; lang: string; text: string }
  | { type: "quote"; children: Block[] }
  | { type: "list"; ordered: boolean; start: number; tight: boolean; items: ListItem[] }
  | { type: "hr" }
  | { type: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  /** A display equation; `open` while its closing `$$` has not come (the end of the text came first). */
  | { type: "math"; tex: string; open: boolean };

// ---- detection -------------------------------------------------------------------------------

const DETECT_STRONG = [
  /^ {0,3}#{1,6}[ \t]+\S/m, // ATX heading
  /^ {0,3}(?:`{3,}|~{3,})/m, // code fence
  /^ {0,3}\|?[ \t]*:?-{3,}:?[ \t]*\|[ \t]*:?-{3,}:?/m, // table delimiter row
  /\[[^\]\n]+\]\((?:https?:\/\/|mailto:|\/|#|\.)[^)\s]*\)/, // inline link
  /^ {0,3}\$\$[^$]+\$\$[ \t]*$/m, // display equation
  /(?<![$\\])\$(?![\s$])[^$\n]*\\[a-zA-Z]+[^$\n]*(?<![\s\\])\$(?![\d$])/, // equation with a TeX command
  /<(b|strong|i|em|s|del|strike|sup|sub|u|mark|kbd|small)>[^<]*<\/\1>/i, // paired inline HTML
  /<br[ \t]*\/?[ \t]*>/i, // inline HTML line break
];

const DETECT_WEAK = [
  /^ {0,3}[-*+][ \t]+\S/gm, // bullet item
  /^ {0,3}\d{1,9}[.)][ \t]+\S/gm, // ordered item
  /^ {0,3}>[ \t]?\S/gm, // block quote
  /(?:\*\*|__)\S(?:[^\n]*?\S)?(?:\*\*|__)/g, // strong
  /`[^`\n]+`/g, // inline code
  /^ {0,3}(?:[-*_][ \t]*){3,}$/gm, // thematic break
  /(?<![$\\])\$(?![\s$])[^$\n]*[\^_][^$\n]*(?<![\s\\])\$(?![\d$])/g, // equation with a sub- or superscript
];

/**
 * Whether the source text looks written in Markdown: one unambiguous construct (heading, fence,
 * table, link, display equation, an equation with a TeX command, paired inline HTML), or at least two of the weaker
 * hints (list items, quotes, strong, code spans, breaks, equations with `^` or `_`), which plain text
 * seldom has together.
 */
export function looksLikeMarkdown(source: string): boolean {
  if (DETECT_STRONG.some((re) => re.test(source))) {
    return true;
  }
  let hints = 0;
  for (const re of DETECT_WEAK) {
    hints += source.match(re)?.length ?? 0;
    if (hints >= 2) {
      return true;
    }
  }
  return false;
}

// ---- blocks ----------------------------------------------------------------------------------

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})[ \t]*(.*)$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const BULLET = /^( {0,3})([-*+])([ \t]+|$)/;
const ORDERED = /^( {0,3})(\d{1,9})([.)])([ \t]+|$)/;
const TABLE_DELIM = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const TASK = /^\[([ xX])\](?:[ \t]+|$)/;
const MATH_OPEN = /^ {0,3}\$\$(.*)$/;

const isBlank = (line: string) => !/\S/.test(line);

/** Leading tabs count as four columns; the result has them expanded. */
function expandIndent(line: string): string {
  const [m] = /^[ \t]*/.exec(line)!;
  if (!m.includes("\t")) {
    return line;
  }
  let col = 0;
  for (const ch of m) {
    col = ch === "\t" ? col + 4 - (col % 4) : col + 1;
  }
  return " ".repeat(col) + line.slice(m.length);
}

const indentOf = (line: string) => /^ */.exec(line)![0].length;

interface Marker {
  ordered: boolean;
  /** "-", "*" or "+" for bullets, "." or ")" for ordered items: a different one starts a new list. */
  kind: string;
  start: number;
  /** Column where the item's content starts; continuation lines are indented at least this far. */
  contentIndent: number;
  rest: string;
}

function listMarker(line: string): Marker | null {
  let m = BULLET.exec(line);
  let ordered = false;
  let start = 1;
  let kind: string;
  let width: number;
  let spaces: string;
  if (m) {
    kind = m[2]!;
    width = m[1]!.length + 1;
    spaces = m[3]!;
  } else {
    m = ORDERED.exec(line);
    if (!m) {
      return null;
    }
    ordered = true;
    start = Number(m[2]);
    kind = m[3]!;
    width = m[1]!.length + m[2]!.length + 1;
    spaces = m[4]!;
  }
  const rest = line.slice(m[0].length);
  // An empty item, or one whose content is indented five or more, has its content one column after the marker.
  const pad = spaces.length === 0 || spaces.length > 4 || isBlank(rest) ? 1 : spaces.length;
  const content = spaces.length > 4 ? " ".repeat(spaces.length - 1) + rest : rest;
  return { ordered, kind, start, contentIndent: width + pad, rest: content };
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) {
    s = s.slice(1);
  }
  if (s.endsWith("|") && !s.endsWith(String.raw`\|`)) {
    s = s.slice(0, -1);
  }
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (s[i] === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += s[i];
    }
  }
  cells.push(cell.trim());
  return cells;
}

/** True when lines[i] and lines[i + 1] are a table header and delimiter row. */
function tableStart(lines: string[], i: number): boolean {
  const head = lines[i];
  const delim = lines[i + 1];
  if (head === undefined || delim === undefined || !head.includes("|") || !TABLE_DELIM.test(delim)) {
    return false;
  }
  if (!delim.includes("|") && !head.trim().startsWith("|")) {
    return false;
  }
  return splitRow(head).length === splitRow(delim).length;
}

/**
 * The TeX after a line's opening `$$`, and whether the line closes the equation too; null when the
 * line cannot open one: `$$` not at its start, or a second `$$` before its end (`$$a$$ is…` is a
 * paragraph with an equation in it).
 */
function mathOpener(line: string): { rest: string; closed: boolean } | null {
  const m = MATH_OPEN.exec(line);
  if (!m) {
    return null;
  }
  const rest = m[1]!.trimEnd();
  if (rest.endsWith("$$")) {
    const tex = rest.slice(0, -2);
    return tex.includes("$$") || isBlank(tex) ? null : { rest: tex, closed: true };
  }
  return rest.includes("$$") ? null : { rest, closed: false };
}

/**
 * The display equation that starts at lines[i]: from `$$` at the start of a line to the next line
 * that ends with `$$` (the same line or a later one). A blank line before that ends the attempt and
 * the lines are read as a paragraph instead (TeX allows no blank line in an equation), so that a
 * stray `$$` cannot take the rest of the text; at the end of the text the equation is open (a last
 * blank line may be a partial one). Null when there is no equation here.
 */
function mathBlock(lines: string[], i: number): { tex: string; open: boolean; end: number } | null {
  const opener = mathOpener(lines[i]!);
  if (!opener) {
    return null;
  }
  const body = [opener.rest];
  if (opener.closed) {
    return { tex: opener.rest.trim(), open: false, end: i + 1 };
  }
  for (let j = i + 1; j < lines.length; j++) {
    const line = lines[j]!;
    if (isBlank(line)) {
      if (j < lines.length - 1) {
        return null;
      }
      break;
    }
    const t = line.trimEnd();
    if (t.endsWith("$$")) {
      body.push(t.slice(0, -2));
      return { tex: body.join("\n").trim(), open: false, end: j + 1 };
    }
    body.push(line);
  }
  return { tex: body.join("\n").trim(), open: true, end: lines.length };
}

/** Whether a line starts a block that ends a paragraph (and lazy continuation in lists and quotes). */
function interrupts(lines: string[], i: number): boolean {
  const line = lines[i]!;
  if (ATX.test(line) || FENCE_OPEN.test(line) || HR.test(line) || QUOTE.test(line) || mathOpener(line)) {
    return true;
  }
  const marker = listMarker(line);
  if (marker && !isBlank(marker.rest) && (!marker.ordered || marker.start === 1)) {
    return true;
  }
  return tableStart(lines, i);
}

/** Whether the open block at the end of `body` is a paragraph, which is all a lazy line may continue. */
function endsInParagraph(body: string[]): boolean {
  if (!body.length || isBlank(body.at(-1)!)) {
    return false;
  }
  let last = parseLines(body).at(-1)?.block;
  // The innermost open block: through the last quote or list item.
  while (last?.type === "quote" || last?.type === "list") {
    last = last.type === "quote" ? last.children.at(-1) : last.items.at(-1)?.children.at(-1);
  }
  return last?.type === "paragraph";
}

/**
 * A lazy continuation line, made safe to re-parse inside its container: it is paragraph text, so
 * if it looks like a block start ("- x", "1. x", "===", "> x") the marker is escaped, which renders
 * as the same character.
 */
function lazyLine(line: string): string {
  const l = line.trimStart();
  if (!(
    ATX.test(l) ||
    FENCE_OPEN.test(l) ||
    HR.test(l) ||
    QUOTE.test(l) ||
    mathOpener(l) ||
    SETEXT.test(l) ||
    listMarker(l) ||
    l.startsWith("|")
  )) {
    return l;
  }
  return /^\d/.test(l) ? l.replace(/^(\d+)([.)])/, String.raw`$1\$2`) : "\\" + l;
}

export interface ParsedBlock {
  block: Block;
  /** Index of the block's first line. */
  line: number;
}

/** Parses lines (without their newlines) into top-level blocks. */
export function parseLines(rawLines: string[]): ParsedBlock[] {
  const lines = rawLines.map((l) => expandIndent(l.endsWith("\r") ? l.slice(0, -1) : l));
  const out: ParsedBlock[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    const first = i;
    if (isBlank(line)) {
      i++;
      continue;
    }

    const fence = FENCE_OPEN.exec(line);
    if (fence && !(fence[2]!.startsWith("`") && fence[3]!.includes("`"))) {
      const indent = fence[1]!.length;
      const mark = fence[2]!;
      const close = new RegExp(`^ {0,3}${mark.startsWith("`") ? "`" : "~"}{${mark.length},}[ \\t]*$`);
      const body: string[] = [];
      i++;
      while (i < n && !close.test(lines[i]!)) {
        const l = lines[i]!;
        body.push(l.slice(Math.min(indent, indentOf(l))));
        i++;
      }
      // An unclosed fence runs to the end of the text; its trailing blank lines are not content yet.
      if (i >= n) {
        while (body.length && isBlank(body.at(-1)!)) {
          body.pop();
        }
      }
      i++; // the closing fence, or past the end
      out.push({
        block: {
          type: "code",
          lang: unescapePunctuation(fence[3]!.trim().split(/\s+/)[0] ?? ""),
          text: body.join("\n"),
        },
        line: first,
      });
      continue;
    }

    const math = mathBlock(lines, i);
    if (math) {
      out.push({ block: { type: "math", tex: math.tex, open: math.open }, line: first });
      i = math.end;
      continue;
    }

    const atx = ATX.exec(line);
    if (atx) {
      const text = (atx[2] ?? "").replace(/(?:^|[ \t]+)#+[ \t]*$/, "").trim();
      out.push({ block: { type: "heading", level: atx[1]!.length, children: parseInline(text) }, line: first });
      i++;
      continue;
    }

    if (HR.test(line)) {
      out.push({ block: { type: "hr" }, line: first });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < n) {
        const l = lines[i]!;
        if (QUOTE.test(l)) {
          body.push(l.replace(QUOTE, ""));
        }
        // Lazy continuation: an unmarked line continues a quoted paragraph.
        else if (!isBlank(l) && !interrupts(lines, i) && endsInParagraph(body)) {
          body.push(lazyLine(l));
        } else {
          break;
        }
        i++;
      }
      out.push({ block: { type: "quote", children: parseLines(body).map((p) => p.block) }, line: first });
      continue;
    }

    const marker = listMarker(line);
    if (marker) {
      const items: { task: boolean | null; lines: string[] }[] = [];
      let loose = false;
      let current = marker;
      for (;;) {
        let { rest } = current;
        let task: boolean | null = null;
        const t = TASK.exec(rest);
        if (t) {
          task = t[1] !== " ";
          rest = rest.slice(t[0].length);
        }
        const body = [rest];
        i++;
        let blanks = 0;
        let next: Marker | null = null;
        while (i < n) {
          const l = lines[i]!;
          if (isBlank(l)) {
            blanks++;
            body.push("");
            i++;
            continue;
          }
          if (indentOf(l) >= current.contentIndent) {
            if (blanks && body.every(isBlank)) {
              break;
            } // an item that starts empty ends at a blank line
            body.push(l.slice(current.contentIndent));
            blanks = 0;
            i++;
            continue;
          }
          if (HR.test(l)) {
            break;
          }
          const m = listMarker(l);
          if (m) {
            // The same kind of marker adds an item; another kind starts a new list.
            if (m.ordered === current.ordered && m.kind === current.kind) {
              next = m;
            }
            break;
          }
          if (!blanks && !interrupts(lines, i) && endsInParagraph(body)) {
            body.push(lazyLine(l)); // lazy continuation of the item's paragraph
            i++;
            continue;
          }
          break;
        }
        while (body.length > 1 && isBlank(body.at(-1)!)) {
          body.pop();
        }
        items.push({ task, lines: body });
        if (!next) {
          break;
        }
        if (blanks) {
          loose = true;
        }
        current = next;
      }
      const parsed = items.map((it) => {
        const children = parseLines(it.lines);
        // Loose also when a blank line separates two of an item's own blocks (not lines inside one).
        if (children.some((c, k) => k > 0 && isBlank(it.lines[c.line - 1]!))) {
          loose = true;
        }
        return { task: it.task, children: children.map((c) => c.block) };
      });
      out.push({
        block: { type: "list", ordered: marker.ordered, start: marker.start, tight: !loose, items: parsed },
        line: first,
      });
      continue;
    }

    if (tableStart(lines, i)) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]!).map((c): Align => {
        const l = c.startsWith(":");
        const r = c.endsWith(":");
        return l && r ? "center" : r ? "right" : l ? "left" : null;
      });
      i += 2;
      const rows: Inline[][][] = [];
      while (i < n && !isBlank(lines[i]!) && lines[i]!.includes("|") && !interrupts(lines, i)) {
        const cells = splitRow(lines[i]!);
        rows.push(head.map((_, k) => parseInline(cells[k] ?? "")));
        i++;
      }
      out.push({ block: { type: "table", align, head: head.map((h) => parseInline(h)), rows }, line: first });
      continue;
    }

    // Paragraph, or a setext heading when an underline follows.
    const para = [line.trimStart()];
    i++;
    let level = 0;
    while (i < n) {
      const l = lines[i]!;
      if (isBlank(l)) {
        break;
      }
      const setext = SETEXT.exec(l);
      if (setext) {
        level = setext[1]!.startsWith("=") ? 1 : 2;
        i++;
        break;
      }
      if (interrupts(lines, i)) {
        break;
      }
      para.push(l.trimStart());
      i++;
    }
    const children = parseInline(para.join("\n").trimEnd());
    out.push({ block: level ? { type: "heading", level, children } : { type: "paragraph", children }, line: first });
  }
  return out;
}

export function parseMarkdown(text: string): Block[] {
  return parseLines(text.split("\n")).map((p) => p.block);
}

// ---- inlines ---------------------------------------------------------------------------------
//
// The CommonMark algorithm: code spans, equations and autolinks are taken first while scanning; "*", "_" and
// "~~" runs and "[" / "![" go on delimiter stacks; "]" closes the nearest bracket if an inline link
// destination follows, and emphasis is resolved by "process emphasis" with the flanking rules and
// the rule of three. The few supported HTML tags go on a stack of their own, below.

const ASCII_PUNCT = /[!-/:-@[-`{-~]/;
const AUTOLINK = /<((?:https?:\/\/|mailto:)[^\s<>]*)>/iy;
const EMAIL_AUTOLINK =
  /<([\w.!#$%&'*+/=?^`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/y;
const HTML_BR = /<br[ \t]*\/?[ \t]*>/iy;
const HTML_TAG = /<(\/?)(b|strong|i|em|s|del|strike|sup|sub|u|mark|kbd|small)[ \t]*>/iy;

/** The element each supported HTML tag becomes; `<b>`, `<i>` and `<s>` are aliases, as in the page. */
const HTML_TAG_TYPE: Record<string, "em" | "strong" | "del" | "sup" | "sub" | "u" | "mark" | "kbd" | "small"> = {
  b: "strong",
  strong: "strong",
  i: "em",
  em: "em",
  s: "del",
  del: "del",
  strike: "del",
  sup: "sup",
  sub: "sub",
  u: "u",
  mark: "mark",
  kbd: "kbd",
  small: "small",
};
const BARE_URL = /(?<![\p{L}\p{N}])https?:\/\/[^\s<]*[^\s<?!.,:;*_~'")\]]/gu;
const WHITESPACE = /\s/u;
const PUNCTUATION = /[\p{P}\p{S}]/u;
const IDEOGRAPHIC = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}]/u;

/** A sticky regex matched at position i, without copying the rest of the string. */
function matchAt(re: RegExp, s: string, i: number): RegExpExecArray | null {
  re.lastIndex = i;
  return re.exec(s);
}

function runLength(s: string, i: number): number {
  let j = i;
  while (s[j] === s[i]) {
    j++;
  }
  return j - i;
}

/** Index of the backtick run that closes a code span opened by `len` backticks, or -1. */
function codeClose(s: string, from: number, len: number): number {
  for (let j = s.indexOf("`", from); j >= 0; j = s.indexOf("`", j)) {
    const run = runLength(s, j);
    if (run === len) {
      return j;
    }
    j += run;
  }
  return -1;
}

/**
 * The equation that starts with the `$` at s[i] (Pandoc's and GitHub's rules): `$$…$$` is shown as a
 * display equation, `$…$` inline. An inline one needs a non-space after its opening `$` and before
 * its closing one, and no digit after the closing one, so "$5 and $10" stays text; the first `$` that
 * is not escaped by a backslash decides.
 */
function mathSpan(s: string, i: number): { tex: string; display: boolean; end: number } | null {
  const run = runLength(s, i);
  if (run === 2) {
    const close = s.indexOf("$$", i + 2);
    const tex = close === -1 ? "" : s.slice(i + 2, close);
    return /\S/.test(tex) ? { tex: tex.trim(), display: true, end: close + 2 } : null;
  }
  if (run !== 1 || WHITESPACE.test(s[i + 1] ?? " ")) {
    return null;
  }
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === "\\") {
      j++;
    } else if (s[j] === "$") {
      const closes = !WHITESPACE.test(s[j - 1]!) && s[j + 1] !== "$" && !/\d/.test(s[j + 1] ?? "");
      return closes ? { tex: s.slice(i + 1, j), display: false, end: j + 1 } : null;
    }
  }
  return null;
}

const unescapePunctuation = (s: string) => s.replaceAll(/\\([!-/:-@[-`{-~])/g, "$1");

/** Reads `(href "title")` with s[k] === "(". */
function linkTail(s: string, k: number): { href: string; title: string; end: number } | null {
  k++;
  const skipSpace = () => {
    while (s[k] === " " || s[k] === "\t" || s[k] === "\n") {
      k++;
    }
  };
  skipSpace();
  let href: string;
  if (s[k] === "<") {
    let j = k + 1;
    for (; j < s.length && s[j] !== ">"; j++) {
      if (s[j] === "\n" || s[j] === "<") {
        return null;
      }
      if (s[j] === "\\") {
        j++;
      }
    }
    if (j >= s.length) {
      return null;
    }
    href = s.slice(k + 1, j);
    k = j + 1;
  } else {
    let parens = 0;
    const start = k;
    for (; k < s.length; k++) {
      const ch = s[k]!;
      if (ch === "\\" && ASCII_PUNCT.test(s[k + 1] ?? "")) {
        k++;
      } else if (/[ \x00-\x1F\x7F]/.test(ch)) {
        break;
      } else if (ch === "(") {
        parens++;
      } else if (ch === ")") {
        if (parens === 0) {
          break;
        }
        parens--;
      }
    }
    if (parens) {
      return null;
    }
    href = s.slice(start, k);
  }
  const beforeTitle = k;
  skipSpace();
  let title = "";
  const q = s[k];
  if ((q === '"' || q === "'" || q === "(") && k > beforeTitle) {
    const closer = q === "(" ? ")" : q;
    let j = k + 1;
    for (; j < s.length && s[j] !== closer; j++) {
      if (s[j] === "\\") {
        j++;
      }
    }
    if (j >= s.length) {
      return null;
    }
    title = s.slice(k + 1, j);
    k = j + 1;
    skipSpace();
  }
  if (s[k] !== ")") {
    return null;
  }
  return { href: unescapePunctuation(href), title: unescapePunctuation(title), end: k + 1 };
}

function plainText(nodes: Inline[]): string {
  return nodes
    .map((n) =>
      n.type === "text" || n.type === "code"
        ? n.text
        : n.type === "br"
          ? " "
          : n.type === "image"
            ? n.alt
            : n.type === "math"
              ? n.tex
              : plainText(n.children),
    )
    .join("");
}

/** Whether `node` is one of `nodes` or inside one of their children. */
function containsNode(nodes: Inline[], node: Inline): boolean {
  return nodes.some((n) => n === node || ("children" in n && containsNode(n.children, node)));
}

/** Link children cannot hold links: a bare URL or autolink inside a label is unwrapped to its text. */
function unlink(nodes: Inline[]): Inline[] {
  return nodes.flatMap((n): Inline[] =>
    n.type === "link" ? unlink(n.children) : "children" in n ? [{ ...n, children: unlink(n.children) }] : [n],
  );
}

type TextNode = Extract<Inline, { type: "text" }>;

interface Delimiter {
  node: TextNode;
  char: string;
  /** Characters still unused in the run, and the run's original length (for the rule of three). */
  count: number;
  length: number;
  canOpen: boolean;
  canClose: boolean;
}

interface Bracket {
  node: TextNode;
  image: boolean;
  active: boolean;
  /** Delimiters at or above this index lie inside the bracket. */
  bottom: number;
}

interface HtmlTag {
  /** The opening tag as a text node, so an unclosed tag is shown as written. */
  node: TextNode;
  type: "em" | "strong" | "del" | "sup" | "sub" | "u" | "mark" | "kbd" | "small";
  /** Delimiters at or above this index lie inside the tag. */
  bottom: number;
}

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  const delims: Delimiter[] = [];
  const brackets: Bracket[] = [];
  const htmlTags: HtmlTag[] = [];
  let buf = "";
  const flush = () => {
    if (buf) {
      out.push({ type: "text", text: buf });
    }
    buf = "";
  };
  const textNode = (text: string): TextNode => {
    flush();
    const node: TextNode = { type: "text", text };
    out.push(node);
    return node;
  };

  /** Resolves emphasis among the delimiters from index `bottom` up, then drops them from the stack. */
  const processEmphasis = (givenBottom: number) => {
    // A bottom taken before a tag or bracket closed may be past the delimiters that are left.
    const bottom = Math.min(givenBottom, delims.length);
    const openersBottom = new Map<string, number>();
    let c = bottom;
    while (c < delims.length) {
      const closer = delims[c]!;
      if (!closer.canClose) {
        c++;
        continue;
      }
      const key = `${closer.char}${closer.canOpen}${closer.length % 3}`;
      const floor = Math.max(bottom, openersBottom.get(key) ?? bottom);
      let o = c - 1;
      for (; o >= floor; o--) {
        const opener = delims[o]!;
        if (opener.char !== closer.char || !opener.canOpen) {
          continue;
        }
        if (closer.char === "~" && opener.count !== closer.count) {
          continue;
        }
        const oddMatch =
          (opener.canClose || closer.canOpen) &&
          (opener.length + closer.length) % 3 === 0 &&
          !(opener.length % 3 === 0 && closer.length % 3 === 0);
        if (closer.char !== "~" && oddMatch) {
          continue;
        }
        break;
      }
      if (o < floor) {
        openersBottom.set(key, c);
        if (!closer.canOpen) {
          delims.splice(c, 1);
        } else {
          c++;
        }
        continue;
      }
      const opener = delims[o]!;
      const use = closer.char === "~" ? closer.count : closer.count >= 2 && opener.count >= 2 ? 2 : 1;
      opener.count -= use;
      closer.count -= use;
      opener.node.text = opener.node.text.slice(0, opener.count);
      closer.node.text = closer.node.text.slice(use);
      const from = out.indexOf(opener.node);
      const to = out.indexOf(closer.node);
      const children = out.slice(from + 1, to);
      const type = closer.char === "~" ? "del" : use === 2 ? "strong" : "em";
      out.splice(from + 1, to - from - 1, { type, children });
      delims.splice(o + 1, c - o - 1);
      c = o + 1;
      if (opener.count === 0) {
        out.splice(out.indexOf(opener.node), 1);
        delims.splice(o, 1);
        c--;
      }
      if (closer.count === 0) {
        out.splice(out.indexOf(closer.node), 1);
        delims.splice(c, 1);
      }
    }
    delims.length = bottom;
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i]!;

    if (c === "\\") {
      const next = src[i + 1];
      if (next === "\n") {
        flush();
        out.push({ type: "br" });
        i += 2;
      } else if (next !== undefined && ASCII_PUNCT.test(next)) {
        buf += next;
        i += 2;
      } else {
        buf += c;
        i++;
      }
      continue;
    }

    if (c === "\n") {
      // Every line break is kept (see the header); trailing spaces before it are not content.
      buf = buf.replace(/[ \t]+$/, "");
      const last = out.at(-1);
      if (!buf && last?.type === "text") {
        last.text = last.text.replace(/[ \t]+$/, "");
      }
      flush();
      out.push({ type: "br" });
      i++;
      while (src[i] === " " || src[i] === "\t") {
        i++;
      }
      continue;
    }

    if (c === "`") {
      const run = runLength(src, i);
      const close = codeClose(src, i + run, run);
      if (close < 0) {
        buf += src.slice(i, i + run);
        i += run;
        continue;
      }
      let code = src.slice(i + run, close).replaceAll("\n", " ");
      if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && /[^ ]/.test(code)) {
        code = code.slice(1, -1);
      }
      flush();
      out.push({ type: "code", text: code });
      i = close + run;
      continue;
    }

    if (c === "$") {
      const math = mathSpan(src, i);
      if (math) {
        flush();
        out.push({ type: "math", tex: math.tex, display: math.display });
        i = math.end;
      } else {
        // A run that opens nothing is text, all of it: "$$x$" is not "$" and then "$x$".
        const run = runLength(src, i);
        buf += src.slice(i, i + run);
        i += run;
      }
      continue;
    }

    if (c === "<") {
      const m = matchAt(AUTOLINK, src, i);
      const email = m ? null : matchAt(EMAIL_AUTOLINK, src, i);
      if (m || email) {
        flush();
        const text = (m ?? email)![1]!;
        out.push({ type: "link", href: m ? text : `mailto:${text}`, title: "", children: [{ type: "text", text }] });
        i += (m ?? email)![0].length;
        continue;
      }
      const br = matchAt(HTML_BR, src, i);
      if (br) {
        flush();
        out.push({ type: "br" });
        i += br[0].length;
        continue;
      }
      const tag = matchAt(HTML_TAG, src, i);
      if (tag) {
        const type = HTML_TAG_TYPE[tag[2]!.toLowerCase()]!;
        if (!tag[1]) {
          htmlTags.push({ node: textNode(tag[0]), type, bottom: delims.length });
        } else {
          flush();
          const open = htmlTags.at(-1);
          if (open?.type !== type) {
            buf += tag[0]; // a closing tag that closes nothing is text
          } else {
            htmlTags.pop();
            processEmphasis(Math.min(open.bottom, delims.length));
            const from = out.indexOf(open.node);
            if (from === -1) {
              buf += tag[0]; // the opening tag was taken into a link label; the pair cannot span it
            } else {
              const children = out.splice(from + 1);
              out[from] = { type, children };
              // A bracket opened inside the tag can no longer close outside it.
              for (const b of brackets) {
                if (containsNode(children, b.node)) {
                  b.active = false;
                }
              }
            }
          }
        }
        i += tag[0].length;
        continue;
      }
    }

    if (c === "[" || (c === "!" && src[i + 1] === "[")) {
      const image = c === "!";
      brackets.push({ node: textNode(image ? "![" : "["), image, active: true, bottom: delims.length });
      i += image ? 2 : 1;
      continue;
    }

    if (c === "]") {
      const opener = brackets.pop();
      const tail = opener?.active && src[i + 1] === "(" ? linkTail(src, i + 1) : null;
      if (!opener || !tail) {
        buf += "]";
        i++;
        continue;
      }
      flush();
      processEmphasis(opener.bottom);
      const from = out.indexOf(opener.node);
      if (from === -1) {
        // The bracket was taken into a tag or emphasis that has since closed; `](…)` is text.
        buf += src.slice(i, tail.end);
        i = tail.end;
        continue;
      }
      const children = unlink(out.splice(from + 1));
      out[from] = opener.image
        ? { type: "image", href: tail.href, title: tail.title, alt: plainText(children) }
        : { type: "link", href: tail.href, title: tail.title, children };
      // No links inside links: earlier "[" openers can no longer form one.
      if (!opener.image) {
        for (const b of brackets) {
          if (!b.image) {
            b.active = false;
          }
        }
      }
      i = tail.end;
      continue;
    }

    if (c === "*" || c === "_" || (c === "~" && src[i + 1] === "~")) {
      const run = runLength(src, i);
      const before = src[i - 1] ?? "\n";
      const after = src[i + run] ?? "\n";
      const wsBefore = WHITESPACE.test(before);
      const wsAfter = WHITESPACE.test(after);
      const pBefore = PUNCTUATION.test(before);
      const pAfter = PUNCTUATION.test(after);
      // Divergence from CommonMark: ideographic text has no spaces, so a run next to an
      // ideograph may open or close even when punctuation sits on its other side
      // ("**「日本」**です"). See docs/markdown-conformance.md.
      const cjkBefore = IDEOGRAPHIC.test(before);
      const cjkAfter = IDEOGRAPHIC.test(after);
      const left = !wsAfter && (!pAfter || wsBefore || pBefore || cjkBefore);
      const right = !wsBefore && (!pBefore || wsAfter || pAfter || cjkAfter);
      const node = textNode(src.slice(i, i + run));
      if (c !== "~" || run === 2) {
        delims.push({
          node,
          char: c,
          count: run,
          length: run,
          canOpen: c === "_" ? left && (!right || pBefore) : left,
          canClose: c === "_" ? right && (!left || pAfter) : right,
        });
      }
      i += run;
      continue;
    }

    buf += c;
    i++;
  }
  flush();
  processEmphasis(0);

  // Merge the text pieces left by delimiters and brackets that matched nothing.
  const merge = (nodes: Inline[]): Inline[] => {
    const merged: Inline[] = [];
    for (const n of nodes) {
      const prev = merged.at(-1);
      if (n.type === "text" && !n.text) {
        continue;
      }
      if (n.type === "text" && prev?.type === "text") {
        merged[merged.length - 1] = { type: "text", text: prev.text + n.text };
      } else {
        merged.push("children" in n ? { ...n, children: merge(n.children) } : n);
      }
    }
    return merged;
  };
  return linkBareUrls(merge(out));
}

/** GFM extended autolinks: bare http(s) URLs in text outside links become links, after the inline parse. */
function linkBareUrls(nodes: Inline[]): Inline[] {
  return nodes.flatMap((n): Inline[] => {
    if (n.type === "link") {
      return [n];
    }
    if ("children" in n) {
      return [{ ...n, children: linkBareUrls(n.children) }];
    }
    if (n.type !== "text" || !n.text.includes("http")) {
      return [n];
    }
    const parts: Inline[] = [];
    let last = 0;
    for (const m of n.text.matchAll(BARE_URL)) {
      let [url] = m;
      // A closing parenthesis belongs to the URL only if it has an opening one.
      while (url.endsWith(")") && (url.match(/\)/g)?.length ?? 0) > (url.match(/\(/g)?.length ?? 0)) {
        url = url.slice(0, -1);
      }
      if (m.index > last) {
        parts.push({ type: "text", text: n.text.slice(last, m.index) });
      }
      parts.push({ type: "link", href: url, title: "", children: [{ type: "text", text: url }] });
      last = m.index + url.length;
    }
    if (last < n.text.length) {
      parts.push({ type: "text", text: n.text.slice(last) });
    }
    return parts;
  });
}

// ---- streaming -------------------------------------------------------------------------------

/**
 * Splits streamed Markdown into blocks that are finished, handed out once, and the open tail,
 * which is re-parsed on every update. A block counts as finished only when a later complete line
 * has started another block: a partial last line may still turn out to be, say, a setext underline.
 */
export class MarkdownStream {
  private text = "";
  /** Offset in `text` where the open tail starts; everything before it has been handed out. */
  private tailStart = 0;
  /** Index of the line at `tailStart`. */
  private tailLine = 0;

  push(delta: string) {
    this.text += delta;
  }

  /** The blocks finished since the last call, and the current parse of the open tail. */
  take(): { done: Block[]; tail: Block[] } {
    const { done, tail } = this.takeParsed();
    return { done: done.map((p) => p.block), tail: tail.map((p) => p.block) };
  }

  /** As `take`, with each block's first line counted from the start of the whole text. */
  takeParsed(): { done: ParsedBlock[]; tail: ParsedBlock[] } {
    let tail = this.text.slice(this.tailStart);
    const complete = tail.slice(0, tail.lastIndexOf("\n") + 1);
    let done: ParsedBlock[] = [];
    if (complete) {
      const lines = complete.split("\n");
      lines.pop(); // empty after the final newline
      const parsed = parseLines(lines);
      if (parsed.length > 1) {
        const last = parsed.at(-1)!;
        done = parsed.slice(0, -1).map((p) => ({ block: p.block, line: p.line + this.tailLine }));
        let offset = 0;
        for (let k = 0; k < last.line; k++) {
          offset += lines[k]!.length + 1;
        }
        this.tailStart += offset;
        this.tailLine += last.line;
        tail = tail.slice(offset);
      }
    }
    const open = parseLines(tail.split("\n")).map((p) => ({ block: p.block, line: p.line + this.tailLine }));
    return { done, tail: open };
  }
}

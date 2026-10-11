// A small Markdown parser for the translation output, and the test that decides whether to use it.
// Pure: it turns text into a block tree and does no DOM work, so bun test can import it; the page
// builds elements from the tree in `markdown-dom.ts`.
//
// It covers what translated documents and model output use: ATX and setext headings, paragraphs,
// fenced code, block quotes, bullet, ordered and task lists, thematic breaks and GFM tables; inline
// code, emphasis, strong, strikethrough, links, images (shown as links) and autolinks. Raw HTML is
// shown as text. Indented code blocks are not recognised, so indented prose stays prose. A single
// newline inside a paragraph is kept as a line break, as in the plain-text view.
//
// Streaming: a block, once a later line has started another block, never changes. `MarkdownStream`
// relies on this to hand finished blocks out once and re-parse only the open tail.

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "em" | "strong" | "del"; children: Inline[] }
  | { type: "link"; href: string; title: string; children: Inline[] }
  | { type: "image"; href: string; title: string; alt: string }
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
  | { type: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] };

// ---- detection -------------------------------------------------------------------------------

const DETECT_STRONG = [
  /^ {0,3}#{1,6}[ \t]+\S/m, // ATX heading
  /^ {0,3}(?:`{3,}|~{3,})/m, // code fence
  /^ {0,3}\|?[ \t]*:?-{3,}:?[ \t]*\|[ \t]*:?-{3,}:?/m, // table delimiter row
  /\[[^\]\n]+\]\((?:https?:\/\/|mailto:|\/|#|\.)[^)\s]*\)/, // inline link
];

const DETECT_WEAK = [
  /^ {0,3}[-*+][ \t]+\S/gm, // bullet item
  /^ {0,3}\d{1,9}[.)][ \t]+\S/gm, // ordered item
  /^ {0,3}>[ \t]?\S/gm, // block quote
  /(?:\*\*|__)\S(?:[^\n]*?\S)?(?:\*\*|__)/g, // strong
  /`[^`\n]+`/g, // inline code
  /^ {0,3}(?:[-*_][ \t]*){3,}$/gm, // thematic break
];

/**
 * Whether the source text looks written in Markdown: one unambiguous construct (heading, fence,
 * table, link), or at least two of the weaker hints (list items, quotes, strong, code spans,
 * breaks), which plain text seldom has together.
 */
export function looksLikeMarkdown(source: string): boolean {
  if (DETECT_STRONG.some((re) => re.test(source))) return true;
  let hints = 0;
  for (const re of DETECT_WEAK) {
    hints += source.match(re)?.length ?? 0;
    if (hints >= 2) return true;
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

const isBlank = (line: string) => !/\S/.test(line);

/** Leading tabs count as four columns; the result has them expanded. */
function expandIndent(line: string): string {
  const m = /^[ \t]*/.exec(line)![0];
  if (!m.includes("\t")) return line;
  let col = 0;
  for (const ch of m) col = ch === "\t" ? col + 4 - (col % 4) : col + 1;
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
    if (!m) return null;
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
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (s[i] === "|") {
      cells.push(cell.trim());
      cell = "";
    } else cell += s[i];
  }
  cells.push(cell.trim());
  return cells;
}

/** True when lines[i] and lines[i + 1] are a table header and delimiter row. */
function tableStart(lines: string[], i: number): boolean {
  const head = lines[i];
  const delim = lines[i + 1];
  if (head === undefined || delim === undefined || !head.includes("|") || !TABLE_DELIM.test(delim)) return false;
  if (!delim.includes("|") && !head.trim().startsWith("|")) return false;
  return splitRow(head).length === splitRow(delim).length;
}

/** Whether a line starts a block that ends a paragraph (and lazy continuation in lists and quotes). */
function interrupts(lines: string[], i: number): boolean {
  const line = lines[i]!;
  if (ATX.test(line) || FENCE_OPEN.test(line) || HR.test(line) || QUOTE.test(line)) return true;
  const marker = listMarker(line);
  if (marker && !isBlank(marker.rest) && (!marker.ordered || marker.start === 1)) return true;
  return tableStart(lines, i);
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
    if (fence && !(fence[2]![0] === "`" && fence[3]!.includes("`"))) {
      const indent = fence[1]!.length;
      const mark = fence[2]!;
      const close = new RegExp(`^ {0,3}${mark[0] === "`" ? "`" : "~"}{${mark.length},}[ \\t]*$`);
      const body: string[] = [];
      i++;
      while (i < n && !close.test(lines[i]!)) {
        const l = lines[i]!;
        body.push(l.slice(Math.min(indent, indentOf(l))));
        i++;
      }
      // An unclosed fence runs to the end of the text; its trailing blank lines are not content yet.
      if (i >= n) while (body.length && isBlank(body[body.length - 1]!)) body.pop();
      i++; // the closing fence, or past the end
      out.push({ block: { type: "code", lang: fence[3]!.trim().split(/\s+/)[0] ?? "", text: body.join("\n") }, line: first });
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
        if (QUOTE.test(l)) body.push(l.replace(QUOTE, ""));
        // Lazy continuation: an unmarked line continues the quoted paragraph.
        else if (!isBlank(l) && !isBlank(body[body.length - 1] ?? "") && !interrupts(lines, i)) body.push(l);
        else break;
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
        let rest = current.rest;
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
            if (blanks && body.every(isBlank)) break; // an item that starts empty ends at a blank line
            if (blanks) loose = true;
            body.push(l.slice(current.contentIndent));
            blanks = 0;
            i++;
            continue;
          }
          const m = listMarker(l);
          if (m && m.ordered === current.ordered && m.kind === current.kind) {
            next = m;
            break;
          }
          if (!blanks && !interrupts(lines, i) && !SETEXT.test(l)) {
            body.push(l.trimStart()); // lazy continuation of the item's paragraph
            i++;
            continue;
          }
          break;
        }
        while (body.length > 1 && isBlank(body[body.length - 1]!)) body.pop();
        items.push({ task, lines: body });
        if (!next) break;
        if (blanks) loose = true;
        current = next;
      }
      const parsed = items.map((it) => ({ task: it.task, children: parseLines(it.lines).map((p) => p.block) }));
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
    const para = [line.trim()];
    i++;
    let level = 0;
    while (i < n) {
      const l = lines[i]!;
      if (isBlank(l)) break;
      const setext = SETEXT.exec(l);
      if (setext) {
        level = setext[1]![0] === "=" ? 1 : 2;
        i++;
        break;
      }
      if (interrupts(lines, i)) break;
      para.push(l.trim());
      i++;
    }
    const children = parseInline(para.join("\n"));
    out.push({ block: level ? { type: "heading", level, children } : { type: "paragraph", children }, line: first });
  }
  return out;
}

export function parseMarkdown(text: string): Block[] {
  return parseLines(text.split("\n")).map((p) => p.block);
}

// ---- inlines ---------------------------------------------------------------------------------

const PUNCT = /[!-/:-@[-`{-~]/;
const AUTOLINK = /<((?:https?:\/\/|mailto:)[^\s<>]*)>/y;
const BARE_URL = /https?:\/\/[^\s<]*[^\s<?!.,:;*_~'")\]]/y;

/** A sticky regex matched at position i, without copying the rest of the string. */
function matchAt(re: RegExp, s: string, i: number): RegExpExecArray | null {
  re.lastIndex = i;
  return re.exec(s);
}

function runLength(s: string, i: number): number {
  let j = i;
  while (s[j] === s[i]) j++;
  return j - i;
}

/** Index of the backtick run that closes a code span opened by `len` backticks, or -1. */
function codeClose(s: string, from: number, len: number): number {
  for (let j = s.indexOf("`", from); j >= 0; j = s.indexOf("`", j)) {
    const run = runLength(s, j);
    if (run === len) return j;
    j += run;
  }
  return -1;
}

/** Index of a closing delimiter run of exactly `len` characters `c`, skipping escapes and code spans. */
function delimClose(s: string, from: number, c: string, len: number): number {
  for (let j = from; j < s.length; ) {
    const ch = s[j];
    if (ch === "\\") {
      j += 2;
    } else if (ch === "`") {
      const run = runLength(s, j);
      const close = codeClose(s, j + run, run);
      j = close < 0 ? j + run : close + run;
    } else if (ch === c) {
      const run = runLength(s, j);
      const after = s[j + run];
      if (run === len && j > from && /\S/.test(s[j - 1]!) && (c !== "_" || !after || !/[\p{L}\p{N}]/u.test(after))) return j;
      j += run;
    } else j++;
  }
  return -1;
}

interface LinkParts {
  label: string;
  href: string;
  title: string;
  end: number;
}

/** Reads `[label](href "title")` with s[i] === "[". */
function linkAt(s: string, i: number): LinkParts | null {
  let depth = 0;
  let j = i;
  for (; j < s.length; j++) {
    const ch = s[j];
    if (ch === "\\") j++;
    else if (ch === "`") {
      const run = runLength(s, j);
      const close = codeClose(s, j + run, run);
      j = (close < 0 ? j + run : close + run) - 1;
    } else if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) break;
  }
  if (j >= s.length || s[j + 1] !== "(") return null;
  const label = s.slice(i + 1, j);
  let k = j + 2;
  while (s[k] === " " || s[k] === "\n") k++;
  let href = "";
  if (s[k] === "<") {
    const close = s.indexOf(">", k);
    if (close < 0 || s.slice(k, close).includes("\n")) return null;
    href = s.slice(k + 1, close);
    k = close + 1;
  } else {
    let parens = 0;
    const start = k;
    for (; k < s.length; k++) {
      const ch = s[k]!;
      if (ch === "\\" && PUNCT.test(s[k + 1] ?? "")) k++;
      else if (/\s/.test(ch)) break;
      else if (ch === "(") parens++;
      else if (ch === ")") {
        if (parens === 0) break;
        parens--;
      }
    }
    href = s.slice(start, k).replace(/\\([!-/:-@[-`{-~])/g, "$1");
  }
  while (s[k] === " " || s[k] === "\n") k++;
  let title = "";
  const q = s[k];
  if (q === '"' || q === "'" || q === "(") {
    const closer = q === "(" ? ")" : q;
    const close = s.indexOf(closer, k + 1);
    if (close < 0) return null;
    title = s.slice(k + 1, close);
    k = close + 1;
    while (s[k] === " " || s[k] === "\n") k++;
  }
  if (s[k] !== ")") return null;
  return { label, href, title, end: k + 1 };
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
            : plainText(n.children),
    )
    .join("");
}

export function parseInline(src: string, inLink = false): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ type: "text", text: buf });
    buf = "";
  };
  const push = (node: Inline) => {
    flush();
    out.push(node);
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i]!;

    if (c === "\\") {
      const next = src[i + 1];
      if (next === "\n") {
        push({ type: "br" });
        i += 2;
      } else if (next !== undefined && PUNCT.test(next)) {
        buf += next;
        i += 2;
      } else {
        buf += c;
        i++;
      }
      continue;
    }

    if (c === "\n") {
      buf = buf.replace(/[ \t]+$/, "");
      push({ type: "br" });
      i++;
      while (src[i] === " " || src[i] === "\t") i++;
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
      let code = src.slice(i + run, close).replace(/\n/g, " ");
      if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && /\S/.test(code)) code = code.slice(1, -1);
      push({ type: "code", text: code });
      i = close + run;
      continue;
    }

    if (!inLink && (c === "[" || (c === "!" && src[i + 1] === "["))) {
      const image = c === "!";
      const link = linkAt(src, image ? i + 1 : i);
      if (link) {
        const children = parseInline(link.label, true);
        push(image ? { type: "image", href: link.href, title: link.title, alt: plainText(children) } : { type: "link", href: link.href, title: link.title, children });
        i = link.end;
        continue;
      }
    }

    if (!inLink && c === "<") {
      const m = matchAt(AUTOLINK, src, i);
      if (m) {
        push({ type: "link", href: m[1]!, title: "", children: [{ type: "text", text: m[1]!.replace(/^mailto:/, "") }] });
        i += m[0].length;
        continue;
      }
    }

    if (!inLink && c === "h" && !/[\p{L}\p{N}]/u.test(src[i - 1] ?? "")) {
      const m = matchAt(BARE_URL, src, i);
      if (m) {
        let url = m[0];
        // A closing parenthesis belongs to the URL only if it has an opening one.
        while (url.endsWith(")") && (url.match(/\)/g)?.length ?? 0) > (url.match(/\(/g)?.length ?? 0)) url = url.slice(0, -1);
        push({ type: "link", href: url, title: "", children: [{ type: "text", text: url }] });
        i += url.length;
        continue;
      }
    }

    if (c === "*" || c === "_" || (c === "~" && src[i + 1] === "~")) {
      const run = runLength(src, i);
      const next = src[i + run];
      const prev = src[i - 1];
      const canOpen = next !== undefined && /\S/.test(next) && !(c === "_" && prev !== undefined && /[\p{L}\p{N}]/u.test(prev));
      let matched = false;
      if (canOpen) {
        const lengths = c === "~" ? (run === 2 ? [2] : []) : [3, 2, 1].filter((l) => l <= run);
        for (const len of lengths) {
          const close = delimClose(src, i + run, c, len);
          if (close < 0) continue;
          buf += c.repeat(run - len);
          const inner = parseInline(src.slice(i + run, close), inLink);
          const node: Inline =
            c === "~"
              ? { type: "del", children: inner }
              : len === 3
                ? { type: "strong", children: [{ type: "em", children: inner }] }
                : { type: len === 2 ? "strong" : "em", children: inner };
          push(node);
          i = close + len;
          matched = true;
          break;
        }
      }
      if (!matched) {
        buf += src.slice(i, i + run);
        i += run;
      }
      continue;
    }

    buf += c;
    i++;
  }
  flush();
  return out;
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

  push(delta: string) {
    this.text += delta;
  }

  /** The blocks finished since the last call, and the current parse of the open tail. */
  take(): { done: Block[]; tail: Block[] } {
    let tail = this.text.slice(this.tailStart);
    const complete = tail.slice(0, tail.lastIndexOf("\n") + 1);
    let done: Block[] = [];
    if (complete) {
      const lines = complete.split("\n");
      lines.pop(); // empty after the final newline
      const parsed = parseLines(lines);
      if (parsed.length > 1) {
        const last = parsed[parsed.length - 1]!;
        done = parsed.slice(0, -1).map((p) => p.block);
        let offset = 0;
        for (let k = 0; k < last.line; k++) offset += lines[k]!.length + 1;
        this.tailStart += offset;
        tail = tail.slice(offset);
      }
    }
    return { done, tail: parseMarkdown(tail) };
  }
}

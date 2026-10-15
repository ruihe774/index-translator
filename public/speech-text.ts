// What is read aloud: turns a text into the short pieces sent to the speech model one at a time.
// Pure, like `markdown.ts`, so bun test can import it.
//
// Markdown is read from its parsed blocks, never from the raw text: no markers, link targets or
// table pipes are spoken. Headings and list items become their own utterances, ordered items are
// numbered, a table row is read as "header: cell" pairs, links are read by their text, images by
// their alt text, and code blocks are skipped (inline code is read). Plain text is read line by line.
//
// Each piece carries the `data-line` of the top-level element it comes from, so the page can show
// which block is being read.

import { type Block, type Inline, parseLines } from "./markdown.ts";

/** The languages IndexTTS-2.5 speaks; the same list as SPEECH_LANGUAGES in src/speech.ts. */
export const SPEECH_LANGS = ["zh", "en", "ja", "es", "ar"];

export function canSpeak(lang: string | undefined): lang is string {
  return lang !== undefined && SPEECH_LANGS.includes(lang);
}

export interface Segment {
  text: string;
  /** First line of the top-level block (Markdown) or the line (plain text) this comes from. */
  line: number;
  /** Silence after it, in milliseconds: longer after a heading or a block than inside a paragraph. */
  pause: number;
}

const PAUSE_SENTENCE = 80;
const PAUSE_BLOCK = 300;
const PAUSE_HEADING = 500;

/** Chinese and Japanese: no spaces between words, full-width punctuation, far fewer characters per second. */
const isCjk = (lang: string) => lang === "zh" || lang === "ja";

/** A piece is filled up to `soft` characters with whole sentences; a single sentence may reach `hard`. */
function limits(lang: string): { soft: number; hard: number } {
  return isCjk(lang) ? { soft: 60, hard: 150 } : { soft: 180, hard: 400 };
}

// ---- Japanese numbers ------------------------------------------------------------------------
//
// The speech engine reads digits correctly in Chinese, English and Spanish, but not in Japanese
// ("2026年" comes out as "二十二年年"), so Japanese digits are written out in kanji first.

const KANJI_DIGITS = "〇一二三四五六七八九";
const KANJI_SMALL = ["", "十", "百", "千"];
const KANJI_LARGE = ["", "万", "億", "兆", "京"];

function kanjiBelow10000(n: number): string {
  let out = "";
  for (let place = 3; place >= 0; place--) {
    const d = Math.floor(n / 10 ** place) % 10;
    if (d === 0) {
      continue;
    }
    // 十, 百 and 千 stand alone for one of them: 十五, not 一十五.
    out += (d === 1 && place > 0 ? "" : KANJI_DIGITS[d]!) + KANJI_SMALL[place]!;
  }
  return out;
}

const kanjiDigitByDigit = (digits: string) => Array.from(digits, (d) => KANJI_DIGITS[Number(d)]!).join("");

/** "2026" → "二千二十六", "23.5" → "二十三点五"; a number with a leading zero is read digit by digit. */
export function kanjiNumber(number: string): string {
  const [whole = "", fraction] = number.replaceAll(",", "").split(".");
  let out: string;
  if (whole.length > 20 || (whole.length > 1 && whole.startsWith("0"))) {
    out = kanjiDigitByDigit(whole);
  } else if (/^0*$/.test(whole)) {
    out = "〇";
  } else {
    out = "";
    const groups = whole.padStart(Math.ceil(whole.length / 4) * 4, "0").match(/\d{4}/g)!;
    groups.forEach((g, k) => {
      const part = kanjiBelow10000(Number(g));
      if (part) {
        out += part + KANJI_LARGE[groups.length - 1 - k]!;
      }
    });
  }
  return fraction ? `${out}点${kanjiDigitByDigit(fraction)}` : out;
}

// ---- text cleaning ---------------------------------------------------------------------------

const WEB_ADDRESS = /https?:\/\/[^\s<>()[\]]+/g;
const SPOKEN = /[\p{L}\p{N}]/u;
const CJK_CHAR = String.raw`[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}、。，！？：；「」『』（）]`;
const CJK_GAP = new RegExp(`(?<=${CJK_CHAR}) (?=${CJK_CHAR})`, "gu");

/** A web address is read as its host name; the rest is noise when spoken. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function clean(text: string, lang: string): string {
  let s = text.replace(WEB_ADDRESS, hostOf);
  // "<" "|" ">" would be taken for the model's inline pronunciation syntax, <word|reading>.
  s = s.replaceAll(/[<>|]/g, " ");
  // Commas count as thousands separators only in the strict form 1,234,567; "1,2,3" and "2026, then" keep theirs.
  if (lang === "ja") {
    s = s.replaceAll(/\d{1,3}(?:,\d{3})+(?!\d)(?:\.\d+)?|\d+(?:\.\d+)?/g, kanjiNumber);
  }
  s = s.replaceAll(/\s+/g, " ").trim();
  // Spaces left between Chinese or Japanese characters, as around a link or bold text, are heard as breaks.
  return isCjk(lang) ? s.replace(CJK_GAP, "") : s;
}

const SENTENCE_END = /[.!?。！？…:：;；]["'”’)）」』】]*$/;

/** Headings, list items and table rows seldom end in punctuation; without it the voice does not come to rest. */
function closed(text: string, lang: string): string {
  if (!text || SENTENCE_END.test(text)) {
    return text;
  }
  return text + (isCjk(lang) ? "。" : ".");
}

// ---- splitting into pieces -------------------------------------------------------------------

function sentences(text: string, lang: string): string[] {
  if (typeof Intl.Segmenter === "function") {
    return Array.from(new Intl.Segmenter(lang, { granularity: "sentence" }).segment(text), (s) => s.segment);
  }
  return text.match(/[^.!?。！？]+[.!?。！？]*\s*/g) ?? [text];
}

/** Cuts an overlong sentence at clause punctuation, then at spaces, then anywhere. */
function clauses(sentence: string, hard: number): string[] {
  const out: string[] = [];
  let cur = "";
  const push = (part: string) => {
    if (cur && cur.length + part.length > hard) {
      out.push(cur);
      cur = "";
    }
    cur += part;
  };
  for (const clause of sentence.split(/(?<=[,;:，；：、])/)) {
    if (clause.length <= hard) {
      push(clause);
      continue;
    }
    for (const word of clause.split(/(?<=\s)/)) {
      if (word.length <= hard) {
        push(word);
      } else {
        // By code points: the server's limit counts them, and a slice by UTF-16 units can cut a pair.
        const chars = Array.from(word);
        for (let i = 0; i < chars.length; i += hard) {
          push(chars.slice(i, i + hard).join(""));
        }
      }
    }
  }
  if (cur) {
    out.push(cur);
  }
  return out;
}

function pieces(text: string, lang: string): string[] {
  const { soft, hard } = limits(lang);
  const out: string[] = [];
  let cur = "";
  for (const sentence of sentences(text, lang).flatMap((s) => (s.length > hard ? clauses(s, hard) : [s]))) {
    if (cur && cur.length + sentence.length > soft) {
      out.push(cur);
      cur = "";
    }
    cur += sentence;
  }
  if (cur) {
    out.push(cur);
  }
  return out.map((p) => p.trim()).filter((p) => SPOKEN.test(p));
}

// ---- Markdown --------------------------------------------------------------------------------

interface Utterance {
  text: string;
  pause: number;
}

function inlineText(nodes: Inline[], lang: string): string {
  return nodes
    .map((n): string => {
      switch (n.type) {
        case "text":
        case "code": {
          return n.text;
        }
        case "br": {
          // Source lines of one paragraph: a wrapped sentence goes on.
          return isCjk(lang) ? "" : " ";
        }
        case "em":
        case "strong":
        case "del":
        case "link": {
          return inlineText(n.children, lang);
        }
        case "image": {
          return n.alt;
        }
      }
    })
    .join("");
}

function tableRows(head: Inline[][], rows: Inline[][][], lang: string): string[] {
  const titles = head.map((h) => inlineText(h, lang).trim());
  const comma = isCjk(lang) ? "，" : ", ";
  const colon = isCjk(lang) ? "：" : ": ";
  if (rows.length === 0) {
    return [titles.filter(Boolean).join(comma)];
  }
  return rows.map((row) =>
    row
      .map((cell, k) => {
        const value = inlineText(cell, lang).trim();
        return value && titles[k] ? titles[k] + colon + value : value;
      })
      .filter(Boolean)
      .join(comma),
  );
}

function blockUtterances(b: Block, lang: string): Utterance[] {
  switch (b.type) {
    case "heading": {
      return [{ text: closed(inlineText(b.children, lang).trim(), lang), pause: PAUSE_HEADING }];
    }
    case "paragraph": {
      return [{ text: inlineText(b.children, lang), pause: PAUSE_BLOCK }];
    }
    case "code":
    case "hr": {
      return [];
    }
    case "quote": {
      return b.children.flatMap((c) => blockUtterances(c, lang));
    }
    case "list": {
      return b.items.flatMap((item, k) => {
        const inner = item.children.flatMap((c) => blockUtterances(c, lang)).filter((u) => SPOKEN.test(u.text));
        const [first] = inner;
        if (!first) {
          return [];
        }
        const number = b.ordered ? `${b.start + k}${isCjk(lang) ? "、" : ". "}` : "";
        inner[0] = { text: number + closed(first.text.trim(), lang), pause: first.pause };
        return inner;
      });
    }
    case "table": {
      return tableRows(b.head, b.rows, lang).map((text) => ({ text: closed(text, lang), pause: PAUSE_BLOCK }));
    }
  }
}

/**
 * The pieces to speak, in reading order. `markdown` says whether the text is shown rendered (the
 * source looked like Markdown); otherwise every line is read as it is.
 */
export function speechSegments(text: string, markdown: boolean, lang: string): Segment[] {
  const lines = text.split("\n");
  const blocks: { line: number; utterances: Utterance[] }[] = markdown
    ? parseLines(lines).map(({ block, line }) => ({ line, utterances: blockUtterances(block, lang) }))
    : lines.map((l, line) => ({ line, utterances: [{ text: l, pause: PAUSE_BLOCK }] }));

  const out: Segment[] = [];
  for (const { line, utterances } of blocks) {
    for (const u of utterances) {
      const parts = pieces(clean(u.text, lang), lang);
      parts.forEach(
        (part, k) => void out.push({ text: part, line, pause: k === parts.length - 1 ? u.pause : PAUSE_SENTENCE }),
      );
    }
  }
  return out;
}

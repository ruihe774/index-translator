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
//
// Where a text is cut follows the probability of a cut after each character. Sentence ends come from
// `Intl.Segmenter`, or from the server's sentence model (SaT, `POST /segment`) when the caller has its
// answer for the exact strings `speechTexts` lists; fetching it is segment.ts's business, not this file's.

import type { SegmentedText } from "../src/api.ts";
import { type Block, type Inline, parseLines } from "./markdown.ts";

/** The languages IndexTTS-2.5 speaks; the same list as SPEECH_LANGUAGES in src/speech.ts. */
export const SPEECH_LANGS = ["zh", "en", "ja", "es", "ar"] as const;
type SpeechLang = (typeof SPEECH_LANGS)[number];

export function canSpeak(lang: string | undefined): lang is string {
  return lang !== undefined && (SPEECH_LANGS as readonly string[]).includes(lang);
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

/**
 * A piece is about `soft` characters long and never beyond `hard` (UTF-16 units). From IndexTTS's measured speed
 * (zh 5.3, ja 6.0, en 18.7, es 16.4, ar 11.0 characters per second): every language aims at about 11 s a piece.
 */
const LIMITS: Record<SpeechLang, { soft: number; hard: number }> = {
  zh: { soft: 60, hard: 150 },
  ja: { soft: 70, hard: 150 },
  en: { soft: 200, hard: 400 },
  es: { soft: 180, hard: 400 },
  ar: { soft: 120, hard: 270 },
};

function limits(lang: string): { soft: number; hard: number } {
  return LIMITS[lang as SpeechLang] ?? LIMITS.en;
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

/** Where each sentence of the text ends (before its trailing whitespace); the end of the text is not one. */
function sentenceEnds(text: string, lang: string): number[] {
  const parts =
    typeof Intl.Segmenter === "function"
      ? Array.from(new Intl.Segmenter(lang, { granularity: "sentence" }).segment(text), (s) => ({
          index: s.index,
          segment: s.segment,
        }))
      : Array.from(text.matchAll(/[^.!?。！？]+[.!?。！？]*\s*/g), (m) => ({ index: m.index, segment: m[0] }));
  return parts
    .map(({ index, segment }) => index + segment.trimEnd().length)
    .filter((end) => end > 0 && end < text.length);
}

const CLAUSE_END = /[,;:،؛，、；：）)」』】]/;
const P_SENTENCE = 0.9;
const P_CLAUSE = 0.01;
const P_WORD = 1e-6;

/**
 * What a sentence model says about a text: offset p (UTF-16 units) means a sentence may end between
 * `text.slice(0, p)` and `text.slice(p)`, with this probability. Positions not listed are unlikely.
 */
export type Boundaries = SegmentedText;
/** What `speechSegments` looks the model's answer up by: the text being cut. */
export type BoundaryLookup = (text: string) => Boundaries | undefined;

/** The model's probability of a cut after each unit (`p[k]`: between unit k and k + 1); 0 where it reports none. */
function modelProbabilities(text: string, lang: string, boundaries: Boundaries): Float64Array {
  const p = new Float64Array(text.length);
  boundaries.offsets.forEach((offset, i) => {
    // The ends of the text are no cuts.
    if (!Number.isInteger(offset) || offset < 1 || offset >= text.length) {
      return;
    }
    // An offset after the whitespace that ends a sentence is the cut before that whitespace.
    let k = offset - 1;
    while (k > 0 && /\s/.test(text[k]!)) {
      k--;
    }
    // Inside a word a cut is impossible, whatever the model says (Chinese and Japanese have no words to split).
    if (isCjk(lang) || /\s/.test(text[k + 1]!)) {
      p[k] = Math.max(p[k]!, boundaries.probabilities[i] ?? 0);
    }
  });
  return p;
}

/**
 * The log of the probability of a cut after each UTF-16 unit (minus infinity: never): high at the end of a
 * sentence, low after clause punctuation, tiny at any other word end. Never inside a word where spaces
 * separate words, nor between the halves of a surrogate pair. With `boundaries` the sentence ends are the
 * model's (its probability where it reports one) instead of `Intl.Segmenter`'s, and clause punctuation
 * stays at least as likely as `P_CLAUSE`.
 */
function cutLogProbabilities(text: string, lang: string, boundaries?: Boundaries): Float64Array {
  const p = new Float64Array(text.length);
  for (let k = 0; k < text.length - 1; k++) {
    if (/[\uD800-\uDBFF]/.test(text[k]!) && /[\uDC00-\uDFFF]/.test(text[k + 1]!)) {
      continue;
    }
    if (CLAUSE_END.test(text[k]!)) {
      p[k] = P_CLAUSE;
    } else if (isCjk(lang) || /\s/.test(text[k + 1]!)) {
      p[k] = P_WORD;
    }
  }
  if (boundaries) {
    const model = modelProbabilities(text, lang, boundaries);
    for (let k = 0; k < p.length; k++) {
      // Only where a cut is possible at all: not in a surrogate pair.
      if (p[k]! > 0 && model[k]! > p[k]!) {
        p[k] = model[k]!;
      }
    }
  } else {
    for (const end of sentenceEnds(text, lang)) {
      p[end - 1] = P_SENTENCE;
    }
  }
  return p.map(Math.log);
}

/**
 * The cuts (the index each piece ends at) of the best segmentation into pieces of at most `hard` units,
 * as wtpsplit's `constrained_segmentation` (Viterbi) finds it: it maximises the sum, over the pieces, of
 * the log of a Gaussian prior on the length plus the log of the probability of the cut that ends it. The
 * prior is centred on the length that divides the text into the nearest whole number of `soft` pieces,
 * so the pieces come out alike. Undefined when no cut within `hard` exists.
 */
function bestCuts(
  text: string,
  lang: string,
  soft: number,
  hard: number,
  boundaries?: Boundaries,
): number[] | undefined {
  const n = text.length;
  const count = Math.max(1, Math.round(n / soft));
  const each = n / count;
  const min = Math.ceil(each / 3);
  const logPrior = Float64Array.from({ length: hard + 1 }, (_, len) => -8 * ((len - each) / each) ** 2);
  const logCut = cutLogProbabilities(text, lang, boundaries);
  const score = new Float64Array(n + 1).fill(-Infinity);
  const from = new Int32Array(n + 1);
  score[0] = 0;
  for (let pos = min; pos <= n; pos++) {
    // The end of the text is no cut.
    const cut = pos < n ? logCut[pos - 1]! : 0;
    if (cut === -Infinity) {
      continue;
    }
    for (let start = Math.max(0, pos - hard); start <= pos - min; start++) {
      const s = score[start]! + logPrior[pos - start]! + cut;
      if (s > score[pos]!) {
        score[pos] = s;
        from[pos] = start;
      }
    }
  }
  if (score[n] === -Infinity) {
    return undefined;
  }
  const cuts: number[] = [];
  for (let pos = from[n]!; pos > 0; pos = from[pos]!) {
    cuts.unshift(pos);
  }
  return cuts;
}

/** Fallback when `bestCuts` finds none: cuts at clause punctuation, then at spaces, then anywhere. */
function clauses(text: string, hard: number): string[] {
  const out: string[] = [];
  let cur = "";
  const push = (part: string) => {
    if (cur && cur.length + part.length > hard) {
      out.push(cur);
      cur = "";
    }
    cur += part;
  };
  for (const clause of text.split(/(?<=[,;:，；：、])/)) {
    if (clause.length <= hard) {
      push(clause);
      continue;
    }
    for (const word of clause.split(/(?<=\s)/)) {
      if (word.length <= hard) {
        push(word);
      } else {
        // By code points: a slice by UTF-16 units can cut a pair.
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

function pieces(text: string, lang: string, boundaries?: Boundaries): string[] {
  const { soft, hard } = limits(lang);
  const cuts = bestCuts(text, lang, soft, hard, boundaries);
  let parts: string[];
  if (cuts) {
    parts = [];
    let start = 0;
    for (let end of [...cuts, text.length]) {
      // Trailing whitespace stays with the piece on its left.
      while (end < text.length && /\s/.test(text[end]!)) {
        end++;
      }
      parts.push(text.slice(start, end));
      start = end;
    }
  } else {
    parts = clauses(text, hard);
  }
  return parts.map((p) => p.trim()).filter((p) => SPOKEN.test(p));
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

/** Every utterance of the text, cleaned: the strings that are cut into pieces. */
function cutTexts(text: string, markdown: boolean, lang: string): { line: number; pause: number; text: string }[] {
  const lines = text.split("\n");
  const blocks: { line: number; utterances: Utterance[] }[] = markdown
    ? parseLines(lines).map(({ block, line }) => ({ line, utterances: blockUtterances(block, lang) }))
    : lines.map((l, line) => ({ line, utterances: [{ text: l, pause: PAUSE_BLOCK }] }));
  return blocks.flatMap(({ line, utterances }) =>
    utterances.map((u) => ({ line, pause: u.pause, text: clean(u.text, lang) })),
  );
}

/**
 * The texts `speechSegments` cuts that a sentence model can help with, each with the first line of its
 * block, in reading order: exactly the strings `boundaries` is looked up by. A text too short to be cut
 * into several pieces is not among them (a cut never pays off), nor one with nothing to say.
 */
export function speechTexts(text: string, markdown: boolean, lang: string): { line: number; text: string }[] {
  const { soft } = limits(lang);
  return cutTexts(text, markdown, lang)
    .filter((u) => SPOKEN.test(u.text) && Math.round(u.text.length / soft) >= 2)
    .map((u) => ({ line: u.line, text: u.text }));
}

/**
 * The pieces to speak, in reading order. `markdown` says whether the text is shown rendered (the
 * source looked like Markdown); otherwise every line is read as it is. `boundaries` gives, for a text
 * of `speechTexts`, the sentence model's answer when there is one: it is then cut by that, not by
 * `Intl.Segmenter`.
 */
export function speechSegments(text: string, markdown: boolean, lang: string, boundaries?: BoundaryLookup): Segment[] {
  const out: Segment[] = [];
  for (const { line, pause, text: cleaned } of cutTexts(text, markdown, lang)) {
    const parts = pieces(cleaned, lang, boundaries?.(cleaned));
    parts.forEach(
      (part, k) => void out.push({ text: part, line, pause: k === parts.length - 1 ? pause : PAUSE_SENTENCE }),
    );
  }
  return out;
}

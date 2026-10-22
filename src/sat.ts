// SaT (Segment any Text, sat-3l-sm) without the runtime: XLM-RoBERTa's tokenizer, read from the
// model's `tokenizer.json`, and wtpsplit's way of running a text through the model in overlapping
// windows. The model itself runs elsewhere (`RunModel`: ONNX Runtime on the segmentation worker), so
// everything here is plain TypeScript and testable without it.
//
// The tokenizer is Hugging Face's for xlm-roberta-base: a Precompiled normalizer (sentencepiece's
// nmt_nfkc, done here as transformers.js does it: control characters dropped, space-like ones made
// spaces, NFKC), whitespace splitting with a "▁" before every word, and a Unigram model. Offsets
// follow Hugging Face's too, since wtpsplit gives each token's probability to the last character of
// the token's span: a lone "▁" spans the first character of its word.

/** Logits of a batch: `ids` and `mask` are `rows × width`, row-major; one logit per token comes back. */
export type RunModel = (ids: BigInt64Array, mask: Float32Array, rows: number, width: number) => Float32Array;

export interface Boundaries {
  /** After how many UTF-16 code units of the text, ascending. */
  offsets: number[];
  /** The model's probability that a sentence ends there, three significant digits. */
  probabilities: number[];
}

/** What the tokenizer reads of Hugging Face's `tokenizer.json`. */
export interface TokenizerJson {
  added_tokens: { id: number; content: string }[];
  model: { type?: string; unk_id: number; vocab: [string, number][] };
}

const CLS = 0;
const SEP = 2;
/** Tokens per window besides the two special ones: the model's 512 positions. */
const BLOCK = 510;
/**
 * How far each window moves on. wtpsplit's default is 64, which reads every token about eight times
 * in a long text; 256 gave the same sentences on every long block tried (one Arabic boundary apart).
 */
const STRIDE = 256;
/** Windows per run of the model. */
const BATCH = 8;
/** sentencepiece's penalty for an unknown piece, below the lowest score. */
const UNK_PENALTY = 10;

const CONTROL = /[\u0001-\u0008\u000B\u000E-\u001F\u007F\u008F\u009F]/u;
const SPACE_LIKE =
  /[\u0009\u000A\u000C\u000D\u00A0\u1680\u2000-\u200F\u2028\u2029\u202F\u205F\u2581\u3000\uFEFF\uFFFD]/u;
/** A code point and the combining marks after it, normalized together so NFKC can compose them. */
const CLUSTER = /\P{M}\p{M}*|\p{M}+/gsu;
const SPACE = "▁";

export class XlmrTokenizer {
  private readonly pieces = new Map<string, { id: number; score: number }>();
  /** Longest piece, in code points. */
  private readonly longest: number;
  private readonly unkId: number;
  private readonly unkScore: number;

  constructor(json: TokenizerJson) {
    // xlm-roberta-base's file names no model type; a Unigram model is the one with scores and unk_id.
    if ((json.model.type ?? "Unigram") !== "Unigram" || !Array.isArray(json.model.vocab)) {
      throw new Error(`expected a Unigram tokenizer, got ${json.model.type}`);
    }
    const special = new Set(json.added_tokens.map((t) => t.content));
    let longest = 1;
    let lowest = 0;
    json.model.vocab.forEach(([piece, score], id) => {
      lowest = Math.min(lowest, score);
      // Special tokens are never matched in text.
      if (!special.has(piece)) {
        this.pieces.set(piece, { id, score });
        // In code points, as the words are matched.
        longest = Math.max(longest, Array.from(piece).length);
      }
    });
    this.longest = longest;
    this.unkId = json.model.unk_id;
    this.unkScore = lowest - UNK_PENALTY;
  }

  /** Token ids of `text` without special tokens, and where each token's span ends (UTF-16 code units). */
  encode(text: string): { ids: number[]; ends: number[] } {
    // Normalized code points, each with the end of the original text it came from.
    const chars: string[] = [];
    const from: number[] = [];
    for (const m of text.matchAll(CLUSTER)) {
      const kept: string[] = [];
      const keptEnds: number[] = [];
      let at = m.index;
      for (const c of m[0]) {
        at += c.length;
        if (!CONTROL.test(c)) {
          kept.push(SPACE_LIKE.test(c) ? " " : c);
          keptEnds.push(at);
        }
      }
      const cluster = kept.join("");
      const normalized = cluster.includes("～") ? cluster : cluster.normalize("NFKC");
      if (normalized === cluster) {
        // Each character keeps its own end: a token may end between a letter and its mark (Arabic vowels).
        chars.push(...kept);
        from.push(...keptEnds);
      } else {
        for (const c of normalized) {
          chars.push(c);
          from.push(at);
        }
      }
    }
    const ids: number[] = [];
    const ends: number[] = [];
    for (let i = 0; i < chars.length;) {
      if (/\s/u.test(chars[i]!)) {
        i++;
        continue;
      }
      let j = i;
      while (j < chars.length && !/\s/u.test(chars[j]!)) {
        j++;
      }
      // The word with its "▁", which takes the place (and offset) of the word's first character.
      const word = [SPACE, ...chars.slice(i, j)];
      const wordEnds = [from[i]!, ...from.slice(i, j)];
      for (const [, stop, id] of this.viterbi(word)) {
        ids.push(id);
        ends.push(wordEnds[stop - 1]!);
      }
      i = j;
    }
    return { ids, ends };
  }

  /** The best split of one word into pieces, as [start, end, id] over its code points; unknown runs fused. */
  private viterbi(word: string[]): [number, number, number][] {
    const n = word.length;
    const best = new Float64Array(n + 1).fill(-Infinity);
    const back = new Int32Array(n + 1);
    const pieceAt = new Int32Array(n + 1);
    best[0] = 0;
    for (let start = 0; start < n; start++) {
      if (best[start] === -Infinity) {
        continue;
      }
      let single = false;
      let piece = "";
      for (let end = start + 1; end <= Math.min(n, start + this.longest); end++) {
        piece += word[end - 1];
        const found = this.pieces.get(piece);
        if (!found) {
          continue;
        }
        single ||= end === start + 1;
        const score = best[start]! + found.score;
        if (score > best[end]!) {
          best[end] = score;
          back[end] = start;
          pieceAt[end] = found.id;
        }
      }
      // A character no piece starts with is an unknown token of its own.
      if (!single && best[start]! + this.unkScore > best[start + 1]!) {
        best[start + 1] = best[start]! + this.unkScore;
        back[start + 1] = start;
        pieceAt[start + 1] = this.unkId;
      }
    }
    const out: [number, number, number][] = [];
    for (let end = n; end > 0; end = back[end]!) {
      const start = back[end]!;
      const id = pieceAt[end]!;
      const [next] = out;
      if (id === this.unkId && next?.[2] === this.unkId) {
        next[0] = start;
      } else {
        out.unshift([start, end, id]);
      }
    }
    return out;
  }
}

/**
 * Where a sentence may end in each text, as wtpsplit's SaT finds it: every text is tokenized, read in
 * windows of 510 tokens (overlapping by 254, the logits of a token averaged over the windows that
 * hold it), and each token's probability is given to the last character of its span. Windows are run
 * `BATCH` at a time, shortest first, each batch padded to its longest window. `aborted` is asked
 * between batches; when it says so the result is undefined.
 */
export function findBoundaries(
  tokenizer: XlmrTokenizer,
  texts: string[],
  run: RunModel,
  minProbability: number,
  aborted: () => boolean = () => false,
): Boundaries[] | undefined {
  const encoded = texts.map((t) => tokenizer.encode(t));
  const windows: { text: number; start: number; end: number }[] = [];
  encoded.forEach(({ ids }, text) => {
    for (let start = 0; start < ids.length; start += STRIDE) {
      const end = Math.min(start + BLOCK, ids.length);
      windows.push({ text, start: Math.max(0, end - BLOCK), end });
      if (end === ids.length) {
        break;
      }
    }
  });
  windows.sort((a, b) => a.end - a.start - (b.end - b.start));
  const sums = encoded.map(({ ids }) => new Float64Array(ids.length));
  const counts = encoded.map(({ ids }) => new Uint16Array(ids.length));
  for (let first = 0; first < windows.length; first += BATCH) {
    if (aborted()) {
      return undefined;
    }
    const batch = windows.slice(first, first + BATCH);
    const width = Math.max(...batch.map((w) => w.end - w.start)) + 2;
    const ids = new BigInt64Array(batch.length * width);
    const mask = new Float32Array(batch.length * width);
    batch.forEach(({ text, start, end }, row) => {
      const at = row * width;
      ids[at] = BigInt(CLS);
      encoded[text]!.ids.slice(start, end).forEach((id, k) => void (ids[at + 1 + k] = BigInt(id)));
      ids[at + 1 + end - start] = BigInt(SEP);
      mask.fill(1, at, at + end - start + 2);
    });
    const logits = run(ids, mask, batch.length, width);
    batch.forEach(({ text, start, end }, row) => {
      for (let t = start; t < end; t++) {
        sums[text]![t]! += logits[row * width + 1 + t - start]!;
        counts[text]![t]!++;
      }
    });
  }
  return encoded.map(({ ends }, text) => {
    const best = new Map<number, number>();
    ends.forEach((end, t) => {
      const p = 1 / (1 + Math.exp(-sums[text]![t]! / counts[text]![t]!));
      if (p >= minProbability && p > (best.get(end) ?? 0)) {
        best.set(end, p);
      }
    });
    const offsets = [...best.keys()].sort((a, b) => a - b);
    return { offsets, probabilities: offsets.map((o) => Number(best.get(o)!.toPrecision(3))) };
  });
}

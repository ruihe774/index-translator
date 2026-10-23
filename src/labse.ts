// LaBSE (Language-agnostic BERT Sentence Embedding) without the runtime: BERT's WordPiece tokenizer,
// read from the model's `vocab.txt`, and the sentence-transformers pooling that turns the encoder's
// output into one vector per sentence. The encoder itself runs elsewhere (`RunEncoder`: ONNX Runtime on
// the segmentation worker), so everything here is plain TypeScript and testable without it.
//
// The tokenizer is Hugging Face's for LaBSE: a BertNormalizer that keeps case and accents (control
// characters dropped, white space made spaces, CJK ideographs set apart), a BertPreTokenizer (split
// at white space, every punctuation mark a word of its own), and greedy longest-match WordPiece with
// "##" before a piece that continues a word. The embedding is the first ([CLS]) token's state through
// a Dense layer (768 → 768, tanh), normalized to length 1, so a dot product is a cosine.

/** The encoder's last hidden state for a batch: `ids` and `mask` are `rows × width`; `DIMENSIONS` floats per token come back. */
type RunEncoder = (ids: BigInt64Array, mask: BigInt64Array, rows: number, width: number) => Float32Array;

export const DIMENSIONS = 768;

const PAD = 0;
/** Tokens per sentence besides [CLS] and [SEP]: the model's 512 positions. A longer sentence is cut. */
const MAX_TOKENS = 510;
/** A word longer than this, in code points, is one unknown token. */
const MAX_WORD = 100;
/** Sentences per run of the encoder. */
const BATCH = 16;

const WHITE_SPACE = /\p{White_Space}/u;
/** BERT's control characters (Unicode's "Other" categories), which are dropped, except `LINE_SPACE`. */
const CONTROL = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}]/u;
const LINE_SPACE = /[\t\n\r]/;
const PUNCTUATION = /[\p{P}!-/:-@[-`{-~]/u;

/** Code points BERT treats as CJK ideographs, each its own word. Kana and Hangul are not among them. */
function isIdeograph(cp: number): boolean {
  return (
    (cp >= 0x4e_00 && cp <= 0x9f_ff) ||
    (cp >= 0x34_00 && cp <= 0x4d_bf) ||
    (cp >= 0x2_00_00 && cp <= 0x2_a6_df) ||
    (cp >= 0x2_a7_00 && cp <= 0x2_b7_3f) ||
    (cp >= 0x2_b7_40 && cp <= 0x2_b8_1f) ||
    (cp >= 0x2_b8_20 && cp <= 0x2_ce_af) ||
    (cp >= 0xf9_00 && cp <= 0xfa_ff) ||
    (cp >= 0x2_f8_00 && cp <= 0x2_fa_1f)
  );
}

export class WordPieceTokenizer {
  private readonly vocab = new Map<string, number>();
  private readonly cls: number;
  private readonly sep: number;
  private readonly unk: number;

  /** `vocab` is `vocab.txt`: one token per line, its id the line's number from 0. */
  constructor(vocab: string) {
    vocab.split("\n").forEach((token, id) => {
      const t = token.endsWith("\r") ? token.slice(0, -1) : token;
      if (t !== "" && !this.vocab.has(t)) {
        this.vocab.set(t, id);
      }
    });
    const special = (t: string) => {
      const id = this.vocab.get(t);
      if (id === undefined) {
        throw new Error(`the vocabulary has no ${t}`);
      }
      return id;
    };
    this.cls = special("[CLS]");
    this.sep = special("[SEP]");
    this.unk = special("[UNK]");
  }

  /** The words of `text` after normalization and pre-tokenization. */
  static words(text: string): string[] {
    const words: string[] = [];
    let word = "";
    const end = () => {
      if (word) {
        words.push(word);
        word = "";
      }
    };
    for (const c of text) {
      const cp = c.codePointAt(0)!;
      // Dropped before white space is looked for: a vertical tab or U+0085 joins what is around it.
      if (cp === 0 || cp === 0xff_fd || (CONTROL.test(c) && !LINE_SPACE.test(c))) {
        continue;
      }
      if (WHITE_SPACE.test(c)) {
        end();
      } else if (isIdeograph(cp) || PUNCTUATION.test(c)) {
        end();
        words.push(c);
      } else {
        word += c;
      }
    }
    end();
    return words;
  }

  /** Token ids of `text`, with [CLS] before and [SEP] after, cut to the model's length. */
  encode(text: string): number[] {
    const ids = [this.cls];
    for (const word of WordPieceTokenizer.words(text)) {
      ids.push(...this.pieces(word));
      if (ids.length > MAX_TOKENS) {
        break;
      }
    }
    ids.length = Math.min(ids.length, MAX_TOKENS + 1);
    ids.push(this.sep);
    return ids;
  }

  /** One word as the longest pieces from its start, or [UNK] when some part matches none. */
  private pieces(word: string): number[] {
    const chars = Array.from(word);
    if (chars.length > MAX_WORD) {
      return [this.unk];
    }
    const ids: number[] = [];
    for (let start = 0; start < chars.length;) {
      let end = chars.length;
      let found: number | undefined;
      for (; end > start; end--) {
        const piece = chars.slice(start, end).join("");
        found = this.vocab.get(start > 0 ? `##${piece}` : piece);
        if (found !== undefined) {
          break;
        }
      }
      if (found === undefined) {
        return [this.unk];
      }
      ids.push(found);
      start = end;
    }
    return ids;
  }
}

/** The pooling layer of sentence-transformers' LaBSE: `weight` is 768 × 768, row-major (output × input). */
export interface Dense {
  weight: Float32Array;
  bias: Float32Array;
}

/** `linear.weight` and `linear.bias` of the pooling layer's `model.safetensors`. */
export function readDense(file: Uint8Array): Dense {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const headerSize = Number(view.getBigUint64(0, true));
  const header = JSON.parse(new TextDecoder().decode(file.subarray(8, 8 + headerSize))) as Record<
    string,
    { dtype: string; shape: number[]; data_offsets: [number, number] }
  >;
  const tensor = (name: string, shape: number[]) => {
    const t = header[name];
    if (t?.dtype !== "F32" || t.shape.join(",") !== shape.join(",")) {
      throw new Error(`the pooling layer has no ${name} of float32 ${shape.join(" × ")}`);
    }
    const [from, to] = t.data_offsets;
    // Copied: the file's offsets need not be aligned to 4 bytes.
    return new Float32Array(file.slice(8 + headerSize + from, 8 + headerSize + to).buffer);
  };
  return { weight: tensor("linear.weight", [DIMENSIONS, DIMENSIONS]), bias: tensor("linear.bias", [DIMENSIONS]) };
}

/** tanh(W·h + b), normalized to length 1. */
function pool(dense: Dense, hidden: Float32Array): Float32Array {
  const out = new Float32Array(DIMENSIONS);
  let norm = 0;
  for (let o = 0; o < DIMENSIONS; o++) {
    let sum = dense.bias[o]!;
    const row = o * DIMENSIONS;
    for (let i = 0; i < DIMENSIONS; i++) {
      sum += dense.weight[row + i]! * hidden[i]!;
    }
    const v = Math.tanh(sum);
    out[o] = v;
    norm += v * v;
  }
  norm = Math.sqrt(norm) || 1;
  for (let o = 0; o < DIMENSIONS; o++) {
    out[o]! /= norm;
  }
  return out;
}

/**
 * One unit vector per text, in order. Texts are run `BATCH` at a time, shortest first, each batch padded
 * to its longest (the mask keeps padding out of the result). `aborted` is asked between batches; when it
 * says so the result is undefined.
 */
export function embed(
  tokenizer: WordPieceTokenizer,
  dense: Dense,
  texts: string[],
  run: RunEncoder,
  aborted: () => boolean = () => false,
): Float32Array[] | undefined {
  const encoded = texts.map((t) => tokenizer.encode(t));
  const order = encoded.map((_, i) => i).sort((a, b) => encoded[a]!.length - encoded[b]!.length);
  const out: Float32Array[] = [];
  for (let first = 0; first < order.length; first += BATCH) {
    if (aborted()) {
      return undefined;
    }
    const batch = order.slice(first, first + BATCH);
    const width = Math.max(...batch.map((t) => encoded[t]!.length));
    const ids = new BigInt64Array(batch.length * width).fill(BigInt(PAD));
    const mask = new BigInt64Array(batch.length * width);
    batch.forEach((t, row) => {
      encoded[t]!.forEach((id, k) => {
        ids[row * width + k] = BigInt(id);
        mask[row * width + k] = 1n;
      });
    });
    const hidden = run(ids, mask, batch.length, width);
    batch.forEach((t, row) => {
      const at = row * width * DIMENSIONS;
      out[t] = pool(dense, hidden.subarray(at, at + DIMENSIONS));
    });
  }
  return out;
}

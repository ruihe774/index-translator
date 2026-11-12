// Re-measures the settings of the paragraph matching in src/align.ts (UNMATCHED.paragraphs, OPENING and the
// weights) on translations damaged on purpose: one paragraph of the translation dropped, merged with the next,
// split in two or repeated, at 20%, 50% and 80% of the text. It reports how many of those cases came out as
// exactly the right pairs (`exact`), how many had every pair away from the damage right (`near`: the
// damage's neighbourhood, one paragraph before to two after, may be wrong), and how many clean translations
// were flagged (any pair but 1-1). The embeddings are LaBSE's, on libllama as `POST /align` runs them.
//
// Usage:
//   bun scripts/align_tune.ts corpus <base-url> <dir>   translates with a running backend (both models: it swaps
//                                                       them) into <dir>; skips what is there; takes a while
//   bun scripts/align_tune.ts eval <dir> [params]       params: a JSON array of settings, one run each, e.g.
//                                                       '[{"unmatched":0.8,"opening":120}]' (default: one run
//                                                       with the values in src/align.ts); DETAIL=1 lists
//                                                       the results by kind of damage and by language pair
// Settings: unmatched (UNMATCHED.paragraphs), opening (OPENING), length (LENGTH), neighbours (NEIGHBOURS),
// size (PER_SENTENCE), group22 (allow the 2-2 group for paragraphs).
//
// The corpus is 11 translations of test/fixtures/essays.en.txt and its Chinese translation (the long-prose
// kind: 30 paragraphs; Index-NativeLong-9B for en-zh, zh-en, zh-ja and ja-zh, Index-Translate-9B for en to
// zh, ja, es, de, fr, ko and zh-en, in two halves) and Markdown documents of 18 to 21 blocks made of
// sections of README.md and e2e/README.md (Index-Translate-9B, en to zh, ja, fr, de). A translation whose
// block count differs from its source's is not used. Settings are applied to a copy of src/align.ts in
// <dir>, so the application's own file is never changed.

import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

import { blockStarts, blockTexts } from "../public/paragraphs";
import { loadConfig } from "../src/config";
import { inferenceThreads } from "../src/cpu";
import { DIMENSIONS, embed, readDense, WordPieceTokenizer } from "../src/labse";
import { Embedder } from "../src/llama-embed-ffi";
import { translateStream } from "./longtext";

const ROOT = join(import.meta.dir, "..");
const NATIVE_LONG = "index-nailong-9b";
const MARKDOWN_LANGUAGES = ["zh", "ja", "fr", "de"];
/** Sections of Markdown files that make a document: 900 to 4,500 characters, 5 to 40 blocks. */
const SECTION = { minChars: 900, maxChars: 4500, minBlocks: 5, maxBlocks: 40 };
/** How many Markdown documents are joined into each combined one (so that it reaches the 8 blocks the app asks for). */
const DOCUMENTS_PER_COMBINATION = [3, 3, 2];
const DAMAGE_POSITIONS = [0.2, 0.5, 0.8];

interface Settings {
  unmatched?: number;
  opening?: number;
  length?: number;
  neighbours?: number;
  size?: number;
  group22?: boolean;
}

/** `src/align.ts` as the evaluation uses it. */
interface TunableAlign {
  openings(source: string[], target: string[]): { source: string[]; target: string[] };
  translatedLengths(source: string[], target: string[]): { source: number[]; target: number[] };
  alignSentences(
    source: { embeddings: Float32Array[]; lengths: number[] },
    target: { embeddings: Float32Array[]; lengths: number[] },
    unit: "paragraphs",
  ): { source: number[]; target: number[] }[];
  setSettings(settings: Settings): void;
}

const paragraphs = (text: string) => text.trim().split(/\n\s*\n/);

// ---- corpus ----

type Kind = "prose" | "md";

interface Meta {
  model: string;
  from: string;
  to: string;
  usable: boolean;
}

async function save(dir: string, kind: Kind, id: string, source: string, target: string, meta: Omit<Meta, "usable">) {
  const folder = join(dir, kind, id);
  await mkdir(folder, { recursive: true });
  const ext = kind === "md" ? "md" : "txt";
  const count = (t: string) => (kind === "md" ? blockStarts(t, "paragraphs").length : paragraphs(t).length);
  const [a, b] = [count(source), count(target)];
  await Bun.write(join(folder, `src.${ext}`), `${source}\n`);
  await Bun.write(join(folder, `tgt.${ext}`), `${target}\n`);
  await Bun.write(join(folder, "meta.json"), JSON.stringify({ ...meta, usable: a === b } satisfies Meta));
  console.log(`${a === b ? "ok  " : "SKIP"} ${kind}/${id}: ${a} -> ${b} blocks`);
}

/** The sections of the repository's Markdown files that make short documents with headings, tables, code and lists. */
async function markdownSections(): Promise<{ id: string; text: string }[]> {
  const picked: { id: string; text: string; features: string }[] = [];
  for (const file of ["README.md", "e2e/README.md", "WINDOWS.md", "docs/markdown-conformance.md"]) {
    (await Bun.file(join(ROOT, file)).text()).split(/^(?=#{1,4} )/m).forEach((section, i) => {
      const text = section.trim();
      const blocks = blockStarts(text, "paragraphs").length;
      const features = [
        /^\|.*\|\s*$/m.test(text) && "table",
        /^```/m.test(text) && "code",
        /^\s*[-*] /m.test(text) && "list",
      ]
        .filter(Boolean)
        .join("+");
      if (
        text.length >= SECTION.minChars &&
        text.length <= SECTION.maxChars &&
        blocks >= SECTION.minBlocks &&
        blocks <= SECTION.maxBlocks
      ) {
        picked.push({ id: `${file.replaceAll(/\W+/g, "_")}_${i}`, text, features });
      }
    });
  }
  // Those with a table or code first, then lists, then the rest, up to what the combinations need.
  const rank = (p: { features: string }) => (/table|code/.test(p.features) ? 0 : p.features ? 1 : 2);
  const wanted = DOCUMENTS_PER_COMBINATION.reduce((a, b) => a + b, 0);
  return picked.toSorted((a, b) => rank(a) - rank(b)).slice(0, wanted);
}

async function makeCorpus(baseUrl: string, dir: string): Promise<void> {
  const translate = async (text: string, model: string | undefined, from: string, to: string) =>
    (
      await translateStream(baseUrl, {
        text,
        ...(model && { model }),
        source_lang: from,
        target_lang: to,
        max_output_tokens: 20_000,
      })
    ).translation.trim();
  const fixture = async (name: string) => (await Bun.file(join(ROOT, "test", "fixtures", name)).text()).trim();
  const [en, zh] = await Promise.all([fixture("essays.en.txt"), fixture("essays.zh.txt")]);
  const exists = (kind: Kind, id: string) => Bun.file(join(dir, kind, id, "meta.json")).exists();
  const text = async (kind: Kind, id: string, file: string) =>
    (await Bun.file(join(dir, kind, id, file)).text()).trim();
  const halves = (t: string) => {
    const p = paragraphs(t);
    const at = Math.ceil(p.length / 2);
    return [p.slice(0, at).join("\n\n"), p.slice(at).join("\n\n")] as const;
  };

  // The document model first, so that the backend swaps models once.
  if (!(await exists("prose", "nl-en-zh"))) {
    await save(dir, "prose", "nl-en-zh", en, zh, { model: NATIVE_LONG, from: "en", to: "zh" });
  }
  const long = async (id: string, source: string, from: string, to: string) => {
    if (!(await exists("prose", id))) {
      const target = await translate(source, NATIVE_LONG, from, to);
      await save(dir, "prose", id, source, target, { model: NATIVE_LONG, from, to });
    }
  };
  await long("nl-zh-en", zh, "zh", "en");
  await long("nl-zh-ja", zh, "zh", "ja");
  if (await exists("prose", "nl-zh-ja")) {
    await long("nl-ja-zh", await text("prose", "nl-zh-ja", "tgt.txt"), "ja", "zh");
  }

  for (const [from, to, source] of [
    ["en", "zh", en],
    ["en", "ja", en],
    ["en", "es", en],
    ["en", "de", en],
    ["en", "fr", en],
    ["en", "ko", en],
    ["zh", "en", zh],
  ] as const) {
    const id = `chat-${from}-${to}`;
    if (!(await exists("prose", id))) {
      const [a, b] = halves(source);
      const target = `${await translate(a, undefined, from, to)}\n\n${await translate(b, undefined, from, to)}`;
      await save(dir, "prose", id, source, target, { model: "chat", from, to });
    }
  }

  const sections = await markdownSections();
  let first = 0;
  for (const [group, size] of DOCUMENTS_PER_COMBINATION.entries()) {
    const members = sections.slice(first, first + size);
    first += size;
    for (const to of MARKDOWN_LANGUAGES) {
      const id = `combo${group}-${to}`;
      if (await exists("md", id)) {
        continue;
      }
      const targets: string[] = [];
      for (const { text: section } of members) {
        targets.push(await translate(section, undefined, "en", to));
      }
      await save(dir, "md", id, members.map((m) => m.text).join("\n\n"), targets.join("\n\n"), {
        model: "chat",
        from: "en",
        to,
      });
    }
  }
}

// ---- evaluation ----

interface Doc {
  id: string;
  kind: Kind;
  languages: string;
  source: string[];
  target: string[];
}

async function loadCorpus(dir: string): Promise<Doc[]> {
  const docs: Doc[] = [];
  for (const kind of ["prose", "md"] as const) {
    if (!existsSync(join(dir, kind))) {
      continue;
    }
    for (const id of await readdir(join(dir, kind))) {
      const meta = (await Bun.file(join(dir, kind, id, "meta.json")).json()) as Meta;
      if (!meta.usable) {
        continue;
      }
      const ext = kind === "md" ? "md" : "txt";
      const blocks = async (file: string) => blockTexts(await Bun.file(join(dir, kind, id, file)).text(), "paragraphs");
      docs.push({
        id,
        kind,
        languages: `${meta.from}-${meta.to}`,
        source: await blocks(`src.${ext}`),
        target: await blocks(`tgt.${ext}`),
      });
    }
  }
  return docs;
}

/** A copy of src/align.ts, written to `file`, whose settings `setSettings` changes. */
async function tunableAlign(file: string): Promise<TunableAlign> {
  const source = (await Bun.file(join(ROOT, "src", "align.ts")).text())
    .replace('from "./api"', `from "${join(ROOT, "src", "api")}"`)
    .replaceAll(/^const (NEIGHBOURS|PER_SENTENCE|LENGTH|OPENING_RANGE) =/gm, "let $1 =")
    .replace(/^export const OPENING =/m, "export let OPENING =");
  if (!source.includes("let LENGTH =") || !source.includes("export let OPENING =")) {
    throw new Error("src/align.ts no longer has the constants this script patches");
  }
  await Bun.write(
    file,
    `${source}
export function setSettings(o: { unmatched?: number; opening?: number; length?: number; neighbours?: number; size?: number; group22?: boolean }) {
  if (o.unmatched !== undefined) UNMATCHED.paragraphs = o.unmatched;
  if (o.opening !== undefined) { OPENING = o.opening; OPENING_RANGE = [OPENING / 4, OPENING * 4] as const; }
  if (o.length !== undefined) LENGTH = o.length;
  if (o.neighbours !== undefined) NEIGHBOURS = o.neighbours;
  if (o.size !== undefined) PER_SENTENCE = o.size;
  GROUPS.paragraphs = o.group22 ? SENTENCE_GROUPS : SENTENCE_GROUPS.filter(([a, b]) => a !== 2 || b !== 2);
}
`,
  );
  return (await import(file)) as TunableAlign;
}

const SENTENCE_END = /[.!?。！？]\s*/g;
const splittable = (t: string) => t.length >= 100 && !/^(\||```)/m.test(t);

/** `t` cut in two near its middle, at the sentence end closest to it. */
function halve(t: string): [string, string] {
  const middle = t.length / 2;
  const ends = [...t.matchAll(SENTENCE_END)]
    .map((m) => m.index + m[0].length)
    .filter((i) => i > 20 && i < t.length - 20);
  const at =
    ends.length > 0 ? ends.reduce((a, b) => (Math.abs(b - middle) < Math.abs(a - middle) ? b : a)) : Math.round(middle);
  return [t.slice(0, at).trim(), t.slice(at).trim()];
}

interface Case {
  damage: string;
  /** Where the damage is. */
  at: number;
  target: string[];
  /** The pairs of a right answer, as "source indexes|target indexes". */
  expected: string[];
  /** Another right answer. */
  alternative?: string[];
}

function cases(doc: Doc): Case[] {
  const n = doc.source.length;
  const t = doc.target;
  const all = (pair: (i: number) => string, count = n) => Array.from({ length: count }, (_, i) => pair(i));
  const out: Case[] = [];
  for (const share of DAMAGE_POSITIONS) {
    const k = Math.min(n - 2, Math.max(1, Math.round(n * share)));
    const [a, b] = splittable(t[k]!) ? halve(t[k]!) : ["", ""];
    out.push(
      {
        damage: "drop",
        at: k,
        target: t.toSpliced(k, 1),
        expected: all((i) => (i < k ? `${i}|${i}` : i === k ? `${i}|` : `${i}|${i - 1}`)),
      },
      {
        damage: "merge",
        at: k,
        target: t.toSpliced(k, 2, `${t[k]}\n${t[k + 1]}`),
        expected: all((i) => (i < k ? `${i}|${i}` : i === k ? `${k},${k + 1}|${k}` : `${i + 1}|${i}`), n - 1),
      },
      {
        damage: "repeat",
        at: k,
        target: t.toSpliced(k + 1, 0, t[k]!),
        expected: [...all((i) => (i <= k ? `${i}|${i}` : `${i}|${i + 1}`)), `|${k + 1}`],
        // The copy may as well be taken for a second half of paragraph k: a 1-2 group.
        alternative: all((i) => (i < k ? `${i}|${i}` : i === k ? `${k}|${k},${k + 1}` : `${i}|${i + 1}`)),
      },
    );
    // A block of code or a table is not split.
    if (b) {
      out.push({
        damage: "split",
        at: k,
        target: t.toSpliced(k, 1, a, b),
        expected: all((i) => (i < k ? `${i}|${i}` : i === k ? `${k}|${k},${k + 1}` : `${i}|${i + 1}`)),
      });
    }
  }
  return out;
}

const nearDamage = (pair: string, at: number) =>
  pair
    .split(/[|,]/)
    .filter(Boolean)
    .map(Number)
    .some((i) => i >= at - 1 && i <= at + 2);

interface Tally {
  cases: number;
  exact: number;
  near: number;
}

async function evaluate(dir: string, sets: Settings[]): Promise<void> {
  const docs = await loadCorpus(dir);
  if (docs.length === 0) {
    throw new Error(`no usable translations in ${dir}; run: bun scripts/align_tune.ts corpus <base-url> ${dir}`);
  }
  const cfg = loadConfig(Bun.env);
  const align = await tunableAlign(join(dir, "align-tunable.ts"));
  const tokenizer = new WordPieceTokenizer(await Bun.file(join(cfg.alignModelDir, "vocab.txt")).text());
  const dense = readDense(await Bun.file(join(cfg.alignModelDir, "dense.safetensors")).bytes());
  const encoder = Embedder.load(
    cfg.llamaDir,
    join(cfg.alignModelDir, "model.gguf"),
    inferenceThreads(cfg.segmentThreads),
    DIMENSIONS,
  );
  // Embeddings by text: the DP changes between runs, the openings mostly do not.
  const cache = new Map<string, Float32Array>();
  const vectors = (texts: string[]) => {
    const missing = [...new Set(texts.filter((t) => !cache.has(t)))];
    const embedded = embed(tokenizer, dense, missing, (sequences) => encoder.embed(sequences))!;
    for (const [i, v] of embedded.entries()) {
      cache.set(missing[i]!, v);
    }
    return texts.map((t) => cache.get(t)!);
  };
  const pairsOf = (source: string[], target: string[]): string[] => {
    const read = align.openings(source, target);
    const v = vectors([...read.source, ...read.target]);
    const lengths = align.translatedLengths(source, target);
    return align
      .alignSentences(
        { embeddings: v.slice(0, source.length), lengths: lengths.source },
        { embeddings: v.slice(source.length), lengths: lengths.target },
        "paragraphs",
      )
      .map((p) => `${p.source.join(",")}|${p.target.join(",")}`);
  };
  const percent = (a: number, n: number) => (n > 0 ? ((100 * a) / n).toFixed(1).padStart(5) : "  n/a");

  const prose = docs.filter((d) => d.kind === "prose").length;
  console.log(`${docs.length} documents (${prose} prose, ${docs.length - prose} Markdown)`);
  for (const settings of sets) {
    align.setSettings(settings);
    const by = new Map<string, Tally>();
    const count = (key: string, exact: boolean, near: boolean) => {
      const t = by.get(key) ?? { cases: 0, exact: 0, near: 0 };
      t.cases++;
      t.exact += Number(exact);
      t.near += Number(near);
      by.set(key, t);
    };
    const flagged: string[] = [];
    for (const doc of docs) {
      const clean = pairsOf(doc.source, doc.target);
      if (clean.join(";") !== doc.source.map((_, i) => `${i}|${i}`).join(";")) {
        flagged.push(doc.id);
      }
      for (const c of cases(doc)) {
        const got = new Set(pairsOf(doc.source, c.target));
        const check = (want: string[]) => {
          const missing = want.filter((p) => !got.has(p));
          return { missing, exact: missing.length === 0 && got.size === want.length };
        };
        let result = check(c.expected);
        if (c.alternative && !result.exact) {
          const other = check(c.alternative);
          if (other.exact || other.missing.length < result.missing.length) {
            result = other;
          }
        }
        const near = result.missing.every((p) => nearDamage(p, c.at));
        for (const key of [doc.kind, `${doc.kind}/${c.damage}`, `languages ${doc.languages}`]) {
          count(key, result.exact, near);
        }
        count("all", result.exact, near);
      }
    }
    const line = (key: string) => {
      const t = by.get(key);
      return `${percent(t?.exact ?? 0, t?.cases ?? 0)}% exact, ${percent(t?.near ?? 0, t?.cases ?? 0)}% near`;
    };
    console.log(
      `${JSON.stringify(settings)}  clean flagged ${flagged.length}/${docs.length}${flagged.length > 0 ? ` (${flagged.join(", ")})` : ""}` +
        ` | prose ${line("prose")} | md ${line("md")} | ${by.get("all")?.cases ?? 0} cases`,
    );
    if (Bun.env.DETAIL) {
      for (const key of [...by.keys()].toSorted()) {
        console.log(`    ${key.padEnd(24)} ${line(key)} (n=${by.get(key)!.cases})`);
      }
    }
  }
  encoder.free();
}

const [command, first, second] = Bun.argv.slice(2);
if (command === "corpus" && first && second) {
  await makeCorpus(first.replace(/\/+$/, ""), second);
} else if (command === "eval" && first) {
  await evaluate(first, second ? (JSON.parse(second) as Settings[]) : [{}]);
} else {
  console.error("usage: bun scripts/align_tune.ts corpus <base-url> <dir> | eval <dir> [params-json]");
  process.exit(2);
}

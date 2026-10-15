// Runs the CommonMark spec examples against the web app's Markdown parser (public/markdown.ts) and
// checks the result against the documented divergences in docs/markdown-conformance.md.
// Usage: bun scripts/commonmark.ts [spec.json] [--show <reason>|<example number>...]
// Without a file, the pinned spec version is downloaded. Exit 1 when an example fails that is not
// listed below, or a listed one passes (then update the list and the document).

import { type Block, type Inline, parseMarkdown } from "../public/markdown";

const SPEC_VERSION = "0.31.2";

/**
 * Examples that fail, by reason. "line-breaks" fail only because every newline in a paragraph is
 * kept as a line break; the comparison for all other examples treats a soft break and <br /> alike.
 */
export const KNOWN: Record<string, number[]> = {
  "indented-code": [
    1, 2, 3, 5, 6, 7, 8, 18, 36, 48, 69, 85, 100, 107, 111, 112, 114, 115, 116, 117, 118, 134, 211, 225, 231, 236, 252,
    253, 254, 257, 264, 270, 271, 272, 273, 274, 278, 286, 287, 288, 289, 290, 313,
  ],
  "raw-html": [
    21, 31, 110, 148, 149, 150, 151, 152, 153, 154, 155, 156, 157, 158, 159, 160, 161, 162, 163, 164, 165, 166, 167,
    168, 169, 170, 171, 172, 173, 174, 175, 176, 177, 178, 179, 180, 181, 182, 183, 184, 185, 186, 187, 188, 189, 190,
    191, 195, 201, 308, 309, 344, 475, 476, 477, 491, 494, 524, 536, 613, 614, 615, 616, 617, 623, 625, 626, 627, 628,
    629, 630, 631, 642, 643,
  ],
  "ref-link": [
    23, 33, 192, 193, 194, 196, 198, 200, 202, 203, 204, 205, 206, 207, 208, 210, 214, 215, 216, 217, 218, 317, 527,
    528, 529, 530, 531, 532, 533, 534, 535, 537, 538, 539, 540, 541, 542, 543, 544, 545, 549, 550, 553, 554, 555, 556,
    557, 558, 559, 560, 561, 562, 563, 564, 565, 566, 567, 568, 569, 570, 571, 573, 576, 577, 582, 583, 584, 585, 586,
    587, 588, 589, 591, 592, 593,
  ],
  entity: [25, 26, 27, 32, 34, 37, 38, 39, 40, 41, 503, 506],
  "autolink-scheme": [596, 598, 599, 601],
  "gfm-autolink": [602, 608, 611],
  "line-breaks": [
    14, 28, 46, 49, 70, 81, 82, 87, 88, 93, 95, 104, 105, 106, 113, 138, 145, 213, 220, 222, 223, 224, 228, 229, 230,
    232, 233, 238, 243, 247, 250, 251, 285, 291, 292, 293, 304, 312, 334, 367, 384, 394, 405, 423, 432, 490, 505, 552,
    621, 648, 649,
  ],
};

interface Example {
  markdown: string;
  html: string;
  example: number;
  section: string;
}

// ---- reference rendering: the tree as the spec's HTML (unlike the page, which shifts headings and shows images as links)

const esc = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
function url(s: string): string {
  try {
    return esc(encodeURI(decodeURI(s)));
  } catch {
    return esc(encodeURI(s));
  }
}

function inline(nodes: Inline[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case "text": {
          return esc(n.text);
        }
        case "br": {
          return "<br />\n";
        }
        case "code": {
          return `<code>${esc(n.text)}</code>`;
        }
        case "em":
        case "strong":
        case "del": {
          return `<${n.type}>${inline(n.children)}</${n.type}>`;
        }
        case "link": {
          return `<a href="${url(n.href)}"${n.title ? ` title="${esc(n.title)}"` : ""}>${inline(n.children)}</a>`;
        }
        case "image": {
          return `<img src="${url(n.href)}" alt="${esc(n.alt)}"${n.title ? ` title="${esc(n.title)}"` : ""} />`;
        }
      }
    })
    .join("");
}

function blocks(bs: Block[], tight = false): string {
  return bs
    .map((b) => {
      switch (b.type) {
        case "heading": {
          return `<h${b.level}>${inline(b.children)}</h${b.level}>\n`;
        }
        case "paragraph": {
          return tight ? `${inline(b.children)}\n` : `<p>${inline(b.children)}</p>\n`;
        }
        case "code": {
          return `<pre><code${b.lang ? ` class="language-${esc(b.lang)}"` : ""}>${esc(b.text)}${b.text ? "\n" : ""}</code></pre>\n`;
        }
        case "quote": {
          return `<blockquote>\n${blocks(b.children)}</blockquote>\n`;
        }
        case "hr": {
          return "<hr />\n";
        }
        case "list": {
          const tag = b.ordered ? "ol" : "ul";
          const start = b.ordered && b.start !== 1 ? ` start="${b.start}"` : "";
          return `<${tag}${start}>\n${b.items.map((it) => `<li>${blocks(it.children, b.tight)}</li>\n`).join("")}</${tag}>\n`;
        }
        case "table": {
          return "<table></table>\n";
        } // GFM; not in the CommonMark examples
      }
    })
    .join("");
}

/** Whitespace-insensitive between tags, in the spirit of the spec's normalize.py. */
const normalize = (h: string) =>
  h
    .replaceAll(/\s+<\/li>/g, "</li>")
    .replaceAll(/<li>\s+/g, "<li>")
    .replaceAll(/>\s+</g, "><")
    .replaceAll(/\s+/g, " ")
    .trim();
/** The same, with a soft line break and <br /> counted as equal. */
const normalizeBreaks = (h: string) => normalize(h.replaceAll(/<br \/>\n?/g, "\n"));

// ---- run

const args = Bun.argv.slice(2);
const file = args[0] && !args[0].startsWith("--") ? args.shift()! : null;
const spec = file
  ? ((await Bun.file(file).json()) as Example[])
  : ((await fetch(`https://spec.commonmark.org/${SPEC_VERSION}/spec.json`).then((r) => {
      if (!r.ok) {
        throw new Error(`spec download failed: HTTP ${r.status}`);
      }
      return r.json();
    })) as Example[]);

const reasonOf = new Map<number, string>();
for (const [reason, ids] of Object.entries(KNOWN)) {
  for (const id of ids) {
    reasonOf.set(id, reason);
  }
}

const show = args[0] === "--show" ? new Set(args.slice(1)) : null;
let pass = 0;
const unexpected: number[] = [];
const stale: number[] = [];
const bySection = new Map<string, [number, number]>();
for (const ex of spec) {
  const got = blocks(parseMarkdown(ex.markdown));
  const strict = normalize(got) === normalize(ex.html);
  const loose = normalizeBreaks(got) === normalizeBreaks(ex.html);
  const reason = reasonOf.get(ex.example);
  if (strict) {
    pass++;
  }
  const s = bySection.get(ex.section) ?? [0, 0];
  bySection.set(ex.section, [s[0] + (strict ? 1 : 0), s[1] + 1]);
  // Unlisted: must pass. "line-breaks": must differ only in line breaks. Any other reason: must still fail.
  const expected = !reason ? "pass" : reason === "line-breaks" ? "breaks" : "fail";
  const actual = strict ? "pass" : loose ? "breaks" : "fail";
  if (actual !== expected) {
    (reason && actual === "pass" ? stale : unexpected).push(ex.example);
  }
  if (show && (show.has(String(ex.example)) || (reason && show.has(reason)))) {
    console.log(
      `## Example ${ex.example} (${ex.section})${reason ? `, ${reason}` : ""}\n--- markdown\n${ex.markdown}--- expected\n${ex.html}--- got\n${got}`,
    );
  }
}

if (!show) {
  for (const [section, [ok, n]] of bySection) {
    console.log(`${String(ok).padStart(4)}/${String(n).padEnd(4)} ${section}`);
  }
  console.log(`\nCommonMark ${SPEC_VERSION}: ${pass}/${spec.length} pass.`);
  for (const [reason, ids] of Object.entries(KNOWN)) {
    console.log(`  ${reason}: ${ids.length}`);
  }
}
if (unexpected.length) {
  console.error(`Unexpected failures: ${unexpected.join(", ")} (see --show <number>)`);
}
if (stale.length) {
  console.error(`Listed as divergent but now pass: ${stale.join(", ")}; update KNOWN and docs/markdown-conformance.md`);
}
process.exit(unexpected.length || stale.length ? 1 : 0);

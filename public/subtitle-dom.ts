// Shows SubRip subtitles as a table of cues: number, time and text, one row per cue. The source
// preview is rendered once; the translation is shown again, whole, as it grows (`show`), and only the
// rows that changed are rebuilt, which while streaming are the last one or two. Elements are built
// with the DOM API only; `<i>`, `<b>` and `<u>` in a cue become elements and other tags are dropped.
//
// Each row carries `data-line`, the line of its cue's number in the text, so scrolling, hovering and
// reading aloud find it as they find a Markdown block (`lineElements` in dom.ts). The number and time
// cells are `cue-meta`: no sentence is looked for in them (text-groups.ts). When the cues name their
// speakers (`speakerColumn`), the labels move from the text to a Speaker column, also `cue-meta`.

import type { OutputView } from "./markdown-dom.ts";
import { clock, type Cue, parseSrt, speakerColumn, splitSpeakers, styledRuns } from "./subtitles.ts";

/** A row's content, to tell whether it changed. */
const keyOf = (cue: Cue, speakers: boolean) => [cue.line, cue.index, cue.timing, speakers, ...cue.lines].join("\n");

function cell(className: string, ...children: (Node | string)[]): HTMLTableCellElement {
  const td = document.createElement("td");
  td.className = className;
  td.append(...children);
  return td;
}

function lineNodes(line: string): Node[] {
  return styledRuns(line).map(({ text, styles }) => {
    let node: Node = document.createTextNode(text);
    for (const style of styles) {
      const el = document.createElement(style);
      el.append(node);
      node = el;
    }
    return node;
  });
}

/**
 * The speaker cell's lines: one label per labelled line, and the labels of a joined cue (`S01 / S02`)
 * each on a line of their own, so the column stays as narrow as one label.
 */
function speakerLines(speakers: (string | null)[]): string[] {
  return speakers.flatMap((label) => (label ? label.split(" / ") : [""]));
}

/** Lines with a `<br>` between them. */
const broken = (lines: Node[][]) =>
  lines.flatMap((nodes, k) => (k === 0 ? nodes : [document.createElement("br"), ...nodes]));

function row(cue: Cue, speakers: boolean): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.dataset.line = String(cue.line);
  tr.dataset.key = keyOf(cue, speakers);
  const split = speakers ? splitSpeakers(cue.lines) : { speakers: [], lines: cue.lines };
  const text = broken(split.lines.map(lineNodes));
  const time = document.createElement("span");
  time.className = "cue-end";
  time.textContent = `– ${clock(cue.end)}`;
  tr.append(
    cell("cue-meta cue-index", cue.index),
    cell("cue-meta cue-time", `${clock(cue.start)} `, time),
    ...(speakers
      ? [cell("cue-meta cue-speaker", ...broken(speakerLines(split.speakers).map((l) => [document.createTextNode(l)])))]
      : []),
    cell("cue-text", ...text),
  );
  return tr;
}

function table(speakers: boolean): { table: HTMLTableElement; body: HTMLTableSectionElement; speakers: boolean } {
  const t = document.createElement("table");
  t.className = "cue-table";
  const head = t.createTHead().insertRow();
  // The number and speaker columns are headed "#" and "Sp.", which keeps them narrow; a screen reader
  // hears "Cue" and "Speaker" instead.
  const short = (shown: string, heard: string) => {
    const visible = document.createElement("span");
    visible.ariaHidden = "true";
    visible.textContent = shown;
    const spoken = document.createElement("span");
    spoken.className = "sr-only";
    spoken.textContent = heard;
    return [visible, spoken];
  };
  for (const content of [short("#", "Cue"), ["Time"], ...(speakers ? [short("Sp.", "Speaker")] : []), ["Text"]]) {
    const th = document.createElement("th");
    th.scope = "col";
    th.append(...content);
    head.append(th);
  }
  return { table: t, body: t.createTBody(), speakers };
}

/** Clears `target` and returns the view that shows a subtitle text in it. */
export function subtitleOutput(target: HTMLElement, reduced: boolean): OutputView {
  target.replaceChildren();
  let parts: ReturnType<typeof table> | null = null;
  let text = "";
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const render = () => {
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    frame = 0;
    timer = undefined;
    const cues = (text.trim() && parseSrt(text)) || [];
    if (cues.length === 0) {
      target.replaceChildren();
      parts = null;
      return;
    }
    const speakers = speakerColumn(cues);
    if (parts?.speakers !== speakers) {
      parts = table(speakers);
      target.replaceChildren(parts.table);
    }
    const { rows } = parts.body;
    let k = 0;
    while (k < cues.length && k < rows.length && rows[k]!.dataset.key === keyOf(cues[k]!, speakers)) {
      k++;
    }
    while (rows.length > k) {
      parts.body.lastElementChild!.remove();
    }
    parts.body.append(...cues.slice(k).map((cue) => row(cue, speakers)));
  };

  const schedule = () => {
    if (reduced) {
      timer ??= setTimeout(render, REDUCED_MOTION_FLUSH_MS);
    } else if (!frame) {
      frame = requestAnimationFrame(render);
    }
  };

  return {
    append(t) {
      text += t;
      schedule();
    },
    show(t) {
      text = t;
      schedule();
    },
    finish: render,
  };
}

/** As in markdown-dom.ts: with reduced motion the view changes about once a second while text streams. */
const REDUCED_MOTION_FLUSH_MS = 1000;

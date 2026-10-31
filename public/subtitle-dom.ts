// Shows SubRip subtitles as a table of cues: number, time and text, one row per cue. The source
// preview is rendered once; the translation is shown again, whole, as it grows (`show`), and only the
// rows that changed are rebuilt, which while streaming are the last one or two. Elements are built
// with the DOM API only; `<i>`, `<b>` and `<u>` in a cue become elements and other tags are dropped.
//
// Each row carries `data-line`, the line of its cue's number in the text, so scrolling, hovering and
// reading aloud find it as they find a Markdown block (`lineElements` in dom.ts). The number and time
// cells are `cue-meta`: no sentence is looked for in them (text-groups.ts).

import type { OutputView } from "./markdown-dom.ts";
import { clock, type Cue, parseSrt, styledRuns } from "./subtitles.ts";

/** A row's content, to tell whether it changed. */
const keyOf = (cue: Cue) => [cue.line, cue.index, cue.timing, ...cue.lines].join("\n");

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

function row(cue: Cue): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.dataset.line = String(cue.line);
  tr.dataset.key = keyOf(cue);
  const text = cue.lines.flatMap((line, k) =>
    k === 0 ? lineNodes(line) : [document.createElement("br"), ...lineNodes(line)],
  );
  const time = document.createElement("span");
  time.className = "cue-end";
  time.textContent = `– ${clock(cue.end)}`;
  tr.append(
    cell("cue-meta cue-index", cue.index),
    cell("cue-meta cue-time", `${clock(cue.start)} `, time),
    cell("cue-text", ...text),
  );
  return tr;
}

function table(): { table: HTMLTableElement; body: HTMLTableSectionElement } {
  const t = document.createElement("table");
  t.className = "cue-table";
  const head = t.createTHead().insertRow();
  // The number column is headed "#", which keeps it narrow; a screen reader hears "Cue" instead.
  const shown = document.createElement("span");
  shown.ariaHidden = "true";
  shown.textContent = "#";
  const heard = document.createElement("span");
  heard.className = "sr-only";
  heard.textContent = "Cue";
  for (const content of [[shown, heard], ["Time"], ["Text"]]) {
    const th = document.createElement("th");
    th.scope = "col";
    th.append(...content);
    head.append(th);
  }
  return { table: t, body: t.createTBody() };
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
    if (!parts) {
      parts = table();
      target.replaceChildren(parts.table);
    }
    const { rows } = parts.body;
    let k = 0;
    while (k < cues.length && k < rows.length && rows[k]!.dataset.key === keyOf(cues[k]!)) {
      k++;
    }
    while (rows.length > k) {
      parts.body.lastElementChild!.remove();
    }
    parts.body.append(...cues.slice(k).map(row));
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

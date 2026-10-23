// The engine status line (`#engine`): polls GET /health, shows it as a bar or a sentence, and opens
// the raw answer in a dialog on a plain click. The page learns what else /health says (web pages,
// segmentation, alignment) through `onHealth`.

import type { Health } from "../src/api.ts";
import { API } from "./api.ts";
import { ask } from "./link-dialog.ts";
import { engineDetail, healthMessage, type Vram } from "./messages.ts";

const LOADING_POLL_MS = 2000;
const POLL_MS = 5000;

export interface EngineStatusDeps {
  el: HTMLElement;
  /** Called with each answer of /health. */
  onHealth: (health: Health) => void;
}

export interface EngineStatus {
  /** Polls now, and keeps polling (a hidden page stops, `poll` on `visibilitychange` starts it again). */
  poll(): Promise<void>;
}

// The status is a link to the raw JSON (kept for a new tab or tool); a plain click shows it in a dialog.
async function showEngineDialog() {
  let detail: ReturnType<typeof engineDetail>;
  let json = "";
  try {
    const health = (await (await fetch(`${API}/health`)).json()) as Health;
    detail = engineDetail(health);
    json = JSON.stringify(health, null, 2);
  } catch {
    detail = { message: "The server cannot be reached." };
  }
  await ask({
    title: "Engine status",
    ...detail,
    target: json,
    choices: [],
    preformatted: true,
    closeLabel: "Close",
  });
}

export function initEngineStatus({ el, onHealth }: EngineStatusDeps): EngineStatus {
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Counts up for each poll; a response from an earlier poll is stale and must not overwrite a newer one. */
  let seq = 0;

  /**
   * The engine status: a bar when the GPU memory is known or while a model loads (indeterminate), the
   * sentence otherwise (a warning when `problem`). The words are the link's name and tooltip. The page
   * starts with an indeterminate bar (`index.html`), which a load keeps, so its animation does not restart.
   */
  function show(text: string, loading: boolean, vram: Vram | null, problem: boolean) {
    const key = `${text}|${loading}|${vram?.label}|${vram?.used}|${problem}`;
    if (el.dataset.shown === key) {
      return;
    }
    el.dataset.shown = key;
    el.classList.toggle("problem", problem);
    if (!loading && !vram) {
      el.replaceChildren(text);
      el.removeAttribute("title");
      return;
    }
    const words = vram ? `${text} ${vram.label}.` : text;
    const running = el.querySelector(".bar.indeterminate");
    if (loading && running) {
      el.querySelector(".sr-only")!.textContent = words;
      el.title = words;
      return;
    }
    const bar = document.createElement("span");
    bar.className = loading ? "bar indeterminate" : vram?.tight ? "bar tight" : "bar";
    bar.setAttribute("aria-hidden", "true");
    const fill = document.createElement("span");
    fill.className = "fill";
    if (vram) {
      fill.style.inlineSize = `${((vram.used / vram.total) * 100).toFixed(1)}%`;
    }
    bar.append(fill);
    const name = document.createElement("span");
    name.className = "sr-only";
    name.textContent = words;
    el.replaceChildren(bar, name);
    el.title = words;
  }

  async function poll() {
    // One chain at a time: any pending follow-up poll is replaced by this one.
    clearTimeout(timer);
    timer = undefined;
    const mine = ++seq;
    if (document.hidden) {
      return;
    }
    let text: string;
    let loading = false;
    let vram: Vram | null = null;
    let problem: boolean;
    try {
      const res = await fetch(`${API}/health`);
      const health = (await res.json()) as Health;
      ({ text, loading, vram, problem } = healthMessage(health));
      onHealth(health);
    } catch {
      text = "The server cannot be reached.";
      problem = true;
    }
    if (mine !== seq) {
      return;
    }
    // The next poll follows by itself, faster during a load; a hidden tab stops the chain (the
    // check at the top) and `visibilitychange` starts it again. Page load and each finished
    // translation poll at once besides.
    timer = setTimeout(poll, loading ? LOADING_POLL_MS : POLL_MS);
    show(text, loading, vram, problem);
  }

  el.addEventListener("click", (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    void showEngineDialog();
  });

  return { poll };
}

// The page's confirm dialog: before a link in the output is opened, and before Translate fetches the
// web page whose address is in the source box. A modal <dialog> keeps focus inside and returns it
// to what had it; Cancel comes first and has the initial focus.

import { linkPrompt } from "./links.ts";

/** A button of the dialog besides Cancel; the last one is the primary action. */
export interface DialogChoice {
  value: string;
  label: string;
}

export interface DialogPrompt {
  title: string;
  message: string;
  /** Shown as written, in a box of its own: the address the question is about. */
  target: string;
  choices: DialogChoice[];
  /** The question needs care (a link the check could not match): a warning border. */
  warn?: boolean;
}

interface Parts {
  dialog: HTMLDialogElement;
  title: HTMLElement;
  message: HTMLElement;
  target: HTMLElement;
  row: HTMLElement;
}

let parts: Parts | null = null;
/** Counts the questions asked; the last one is the one on screen. */
let asked = 0;

function build(): Parts {
  const dialog = document.createElement("dialog");
  dialog.className = "link-dialog";
  dialog.setAttribute("aria-labelledby", "link-dialog-title");
  dialog.setAttribute("aria-describedby", "link-dialog-message");
  const title = document.createElement("h2");
  title.id = "link-dialog-title";
  const message = document.createElement("p");
  message.id = "link-dialog-message";
  const target = document.createElement("p");
  target.className = "link-dialog-target";
  const row = document.createElement("div");
  row.className = "link-dialog-buttons";
  dialog.append(title, message, target, row);
  document.body.append(dialog);
  return { dialog, title, message, target, row };
}

function button(value: string, label: string, primary: boolean): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.value = value;
  b.textContent = label;
  if (primary) {
    b.className = "primary";
  }
  return b;
}

/** Asks `prompt`; resolves the value of the choice taken, or "cancel" (Cancel, Escape). */
export function ask(prompt: DialogPrompt): Promise<string> {
  parts ??= build();
  const { dialog, title, message, target, row } = parts;
  dialog.classList.toggle("warn", prompt.warn === true);
  title.textContent = prompt.title;
  message.textContent = prompt.message;
  target.textContent = prompt.target;
  const cancel = button("cancel", "Cancel", false);
  cancel.autofocus = true;
  const choices = prompt.choices.map((c, i) => button(c.value, c.label, i === prompt.choices.length - 1));
  row.replaceChildren(cancel, ...choices);
  // Escape leaves "cancel"; a button says what it was.
  let answer = "cancel";
  for (const b of [cancel, ...choices]) {
    b.addEventListener("click", () => {
      answer = b.value;
      dialog.close(b.value);
    });
  }
  const turn = ++asked;
  return new Promise((resolve) => {
    // `close` is fired a task after the dialog closes: a question asked in between (Escape, then
    // Enter on the button that asks) sees the previous question's event while it is open itself.
    const onClose = () => {
      if (turn === asked && dialog.open) {
        return;
      }
      dialog.removeEventListener("close", onClose);
      resolve(answer);
    };
    dialog.addEventListener("close", onClose);
    dialog.showModal();
  });
}

/** Asks whether to open `href`; resolves true to open it. Escape and Cancel resolve false. */
export async function confirmLink(href: string, paired: boolean): Promise<boolean> {
  const prompt = linkPrompt(paired);
  const answer = await ask({
    title: prompt.title,
    message: prompt.message,
    target: href,
    choices: [{ value: "open", label: prompt.open }],
    warn: !paired,
  });
  return answer === "open";
}

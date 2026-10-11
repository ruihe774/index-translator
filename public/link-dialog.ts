// The confirm dialog shown before a link in the output is opened. A modal <dialog> keeps focus
// inside and returns it to the link; Cancel has the initial focus.

import { linkPrompt } from "./links.js";

interface Parts {
  dialog: HTMLDialogElement;
  title: HTMLElement;
  message: HTMLElement;
  target: HTMLElement;
  open: HTMLButtonElement;
}

let parts: Parts | null = null;

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
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.value = "cancel";
  cancel.textContent = "Cancel";
  cancel.autofocus = true;
  const open = document.createElement("button");
  open.type = "button";
  open.value = "open";
  open.className = "primary";
  row.append(cancel, open);
  dialog.append(title, message, target, row);
  for (const b of [cancel, open]) b.addEventListener("click", () => dialog.close(b.value));
  document.body.append(dialog);
  return { dialog, title, message, target, open };
}

/** Asks whether to open `href`; resolves true to open it. Escape and Cancel resolve false. */
export function confirmLink(href: string, paired: boolean): Promise<boolean> {
  parts ??= build();
  const { dialog, title, message, target, open } = parts;
  const prompt = linkPrompt(paired);
  dialog.dataset.paired = String(paired);
  title.textContent = prompt.title;
  message.textContent = prompt.message;
  target.textContent = href;
  open.textContent = prompt.open;
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "open"), { once: true });
    dialog.returnValue = "cancel";
    dialog.showModal();
  });
}

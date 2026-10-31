// Small DOM helpers the page's modules share.

export function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`missing #${id}`);
  }
  return el as T;
}

/** Writes the text only when it differs, so a status that is read out is not announced again. */
export function setText(el: HTMLElement, text: string) {
  if (el.textContent !== text) {
    el.textContent = text;
  }
}

/** Shows `message` as the field's own error, or hides it (`null`); `aria-invalid` follows. */
export function showFieldError(error: HTMLElement, input: HTMLElement, message: string | null) {
  error.hidden = message === null;
  error.textContent = message ?? "";
  if (message === null) {
    input.removeAttribute("aria-invalid");
  } else {
    input.setAttribute("aria-invalid", "true");
  }
}

/** Sets or clears `lang`, which picks glyph forms and the CJK line-layout rules in css/cjk.css. */
export function setLang(el: HTMLElement, lang: string | undefined) {
  if (lang) {
    el.lang = lang;
  } else {
    el.removeAttribute("lang");
  }
}

/**
 * The elements of a rendered view that carry `data-line`, in reading order: its top-level children
 * (markdown-dom.ts), or the rows of a subtitle table (subtitle-dom.ts).
 */
export function lineElements(view: HTMLElement): HTMLElement[] {
  return [...view.querySelectorAll<HTMLElement>(":scope > [data-line], :scope > table > tbody > tr[data-line]")];
}

/** The element of `lineElements(view)` that holds `node`, else null. */
export function lineElementOf(node: Node, view: HTMLElement): HTMLElement | null {
  const hit = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>("[data-line]");
  return hit && view.contains(hit) ? hit : null;
}

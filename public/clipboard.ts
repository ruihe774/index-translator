// Writing to the clipboard: plain text, with an HTML flavour when there is one and the browser takes it.

/** Copies `text`, as rich text too when `html` is given. False when the browser refused. */
export async function writeClipboard(text: string, html: string | null): Promise<boolean> {
  try {
    if (html !== null && typeof ClipboardItem !== "undefined") {
      try {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": new Blob([text], { type: "text/plain" }),
            "text/html": new Blob([html], { type: "text/html" }),
          }),
        ]);
        return true;
      } catch {
        // No HTML for this browser (or the write was refused): plain text alone is what Copy promised.
      }
    }
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

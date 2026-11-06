// Sharing the text shown in full view through the system share sheet. Pure apart from `navigator`, which is
// passed in, so bun test can import it.

export type ShareType = "text/markdown" | "text/plain";

interface Sharer {
  canShare?(data?: ShareData): boolean;
  share?(data?: ShareData): Promise<void>;
}

/**
 * How `text` can be shared, or null when it cannot: Markdown when it is Markdown and `canShare` takes it as a
 * file of that type, else plain text when `canShare` takes that, else nothing (the button is hidden).
 */
export function shareTypeFor(markdown: boolean, nav: Sharer = navigator): ShareType | null {
  if (typeof nav.canShare !== "function" || typeof nav.share !== "function") {
    return null;
  }
  const accepts = (type: ShareType) => {
    try {
      return nav.canShare!({ files: [new File([""], "text.md", { type })] });
    } catch {
      return false;
    }
  };
  if (markdown && accepts("text/markdown")) {
    return "text/markdown";
  }
  return accepts("text/plain") ? "text/plain" : null;
}

/** Shares `text` as a file of `type` named `name` plus its extension. Resolves false when the reader dismissed the sheet. */
export async function shareText(
  text: string,
  type: ShareType,
  name: "source" | "translation",
  nav: Sharer = navigator,
): Promise<boolean> {
  const file = new File([text], `${name}${type === "text/markdown" ? ".md" : ".txt"}`, { type });
  try {
    await nav.share!({ files: [file] });
    return true;
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      return false;
    }
    throw e;
  }
}

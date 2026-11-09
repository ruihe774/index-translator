// An image as the source.
//
// An opened image stands where the text box is, shown by an `<img>` from a `blob:` URL (the page's
// CSP allows `blob:` in `img-src`, not `data:`). The box stays empty under it. Translate sends the file, and only
// then does it leave the browser; everything that puts a text in the box (`loadSource`, a restored
// history entry) takes the image away.

export interface SourceImage {
  /** The opened file, or null when the source is text. */
  readonly file: File | null;
  /** The picture's size in pixels. */
  readonly size: { width: number; height: number };
  /** Shows `picture`, the decoded `file` (see `decodeImage`), and keeps its URL; null for both takes the image away. */
  set(file: File | null, picture?: DecodedImage): void;
  /** The file as a `data:` URL, for the request. */
  dataUrl(): Promise<string>;
}

/** An image the browser has decoded from `file`, held by a `blob:` URL that `release` frees. */
export interface DecodedImage {
  readonly url: string;
  readonly width: number;
  readonly height: number;
  release(): void;
}

/**
 * Decodes `file` as this browser's `<img>` would; rejects when it cannot. What decodes here is what
 * `set` shows, so no other check is needed after it.
 */
export async function decodeImage(file: File): Promise<DecodedImage> {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
  return { url, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
}

export function initSourceImage(img: HTMLImageElement): SourceImage {
  let file: File | null = null;
  let held: DecodedImage | null = null;
  let size = { width: 0, height: 0 };

  return {
    get file() {
      return file;
    },
    get size() {
      return size;
    },
    set(next, picture) {
      file = next;
      held?.release();
      held = null;
      if (next && picture) {
        held = picture;
        size = { width: picture.width, height: picture.height };
        img.alt = `Image to translate: ${next.name}`;
        img.src = picture.url;
      } else {
        // Gives the pixels back.
        size = { width: 0, height: 0 };
        img.removeAttribute("src");
      }
    },
    dataUrl() {
      const source = file;
      if (!source) {
        return Promise.reject(new Error("no image"));
      }
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error(`${source.name} could not be read`));
        reader.readAsDataURL(source);
      });
    },
  };
}

// An image as the source.
//
// An opened image stands where the text box is, drawn on a canvas (the page's CSP allows no
// `blob:` or `data:` picture). The box stays empty under it. Translate sends the file, and only
// then does it leave the browser; everything that puts a text in the box (`loadSource`, a restored
// history entry) takes the image away.

/** The longer side of the canvas at most: the picture is for looking at, the file is what is sent. */
const MAX_CANVAS_SIDE = 2048;

export interface SourceImage {
  /** The opened file, or null when the source is text. */
  readonly file: File | null;
  /** The drawn picture's size in pixels. */
  readonly size: { width: number; height: number };
  /** Shows `picture`, the decoded `file`, and closes the picture; null for both takes the image away. */
  set(file: File | null, picture?: ImageBitmap): void;
  /** The file as a `data:` URL, for the request. */
  dataUrl(): Promise<string>;
}

export function initSourceImage(canvas: HTMLCanvasElement): SourceImage {
  let file: File | null = null;

  return {
    get file() {
      return file;
    },
    get size() {
      return { width: canvas.width, height: canvas.height };
    },
    set(next, picture) {
      file = next;
      if (next && picture) {
        const scale = Math.min(1, MAX_CANVAS_SIDE / Math.max(picture.width, picture.height));
        canvas.width = Math.max(1, Math.round(picture.width * scale));
        canvas.height = Math.max(1, Math.round(picture.height * scale));
        canvas.getContext("2d")?.drawImage(picture, 0, 0, canvas.width, canvas.height);
        canvas.setAttribute("aria-label", `Image to translate: ${next.name}`);
      } else {
        // Gives the pixels back.
        canvas.width = 0;
        canvas.height = 0;
      }
      picture?.close();
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

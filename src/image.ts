// An uploaded image on its way to the engine: checked, decoded by Bun.Image and written out again
// as a PNG, which is the one format the engine thread is given (libmtmd's stb_image reads it; it
// has no WebP decoder). Every upload takes this path, a PNG too, so the engine only ever sees files
// that Bun wrote, upright (EXIF orientation applied) and of a bounded size.

/** Largest image file accepted. */
export const MAX_IMAGE_BYTES = 8 * 2 ** 20;
/** Largest decoded image, in pixels: a small file can claim a huge canvas. The encoder scales down to about 4 million anyway. */
export const MAX_IMAGE_PIXELS = 50_000_000;
/**
 * A larger picture is scaled to this many pixels here. The encoder takes about 4 million and scales
 * the rest away itself; this only keeps a 50-million-pixel photo from crossing to the engine thread
 * as 200 MB of PNG. Four times the encoder's size, so its own scaling still decides the result.
 */
const ENGINE_PIXELS = 16_000_000;
/** What an upload may be, as Bun.Image names the formats. */
export const IMAGE_FORMATS = ["jpeg", "png", "webp"] as const;

/** Why an upload is not taken; `code` is the API's error code. */
export class ImageRejected extends Error {
  constructor(
    public code: "invalid_request" | "image_too_large",
    message: string,
  ) {
    super(message);
  }
}

/** `file` as an uncompressed PNG. Throws ImageRejected when it is not a JPEG, PNG or WebP image within the limits. */
export async function prepareImage(file: Uint8Array): Promise<Uint8Array> {
  if (file.length > MAX_IMAGE_BYTES) {
    throw new ImageRejected("image_too_large", `the image is larger than ${MAX_IMAGE_BYTES} bytes`);
  }
  try {
    const image = new Bun.Image(file, { maxPixels: MAX_IMAGE_PIXELS });
    const { format, width, height } = await image.metadata();
    if (!(IMAGE_FORMATS as readonly string[]).includes(format)) {
      throw new ImageRejected("invalid_request", `the image must be JPEG, PNG or WebP, not ${format}`);
    }
    const side = Math.max(width, height);
    const scale = Math.sqrt(ENGINE_PIXELS / (width * height));
    // A square box of the scaled longer side: the same whichever way EXIF turns the picture.
    if (scale < 1) image.resize(Math.round(side * scale), Math.round(side * scale), { fit: "inside" });
    // Not compressed: it is read once, on this machine, a moment later.
    return await image.png({ compressionLevel: 0 }).bytes();
  } catch (e) {
    if (e instanceof ImageRejected) throw e;
    const code = (e as { code?: string }).code;
    if (code === "ERR_IMAGE_TOO_MANY_PIXELS") {
      throw new ImageRejected("image_too_large", `the image has more than ${MAX_IMAGE_PIXELS} pixels`);
    }
    if (code === "ERR_IMAGE_UNKNOWN_FORMAT" || code === "ERR_IMAGE_FORMAT_UNSUPPORTED") {
      throw new ImageRejected("invalid_request", "the image must be JPEG, PNG or WebP");
    }
    if (code === "ERR_IMAGE_DECODE_FAILED") {
      throw new ImageRejected("invalid_request", "the image could not be decoded; the file may be damaged");
    }
    throw e;
  }
}

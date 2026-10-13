// An uploaded image on its way to the engine: checked, decoded by Bun.Image and written out again
// as a PNG, which is the one format the engine thread is given (libmtmd's stb_image reads it; it
// has no WebP decoder). Every upload takes this path, a PNG too, so the engine only ever sees files
// that Bun wrote, upright (EXIF orientation applied) and of a bounded size.

/** Largest image file accepted. */
export const MAX_IMAGE_BYTES = 8 * 2 ** 20;
/** Largest decoded image, in pixels: a small file can claim a huge canvas. */
export const MAX_IMAGE_PIXELS = 50_000_000;
/**
 * What libmtmd does to an image before the encoder (`mtmd_image_preprocessor_dyn_size`, clip.cpp's
 * Qwen3-VL branch at the pinned llama.cpp): each side to a multiple of patch size × spatial merge,
 * the area kept within 8 to 4,096 tokens of that many pixels. The mmproj GGUF of index-translate-9b
 * has `clip.vision.patch_size` 16 and `spatial_merge_size` 2 and no min/max pixel keys, so these
 * are clip.cpp's defaults. When the picture already has the target size libmtmd copies it without
 * resampling, so `prepareImage` resizes to it once, here, and the engine gets exactly what it wants.
 * Check them on every llama.cpp pin change and for every other mmproj.
 */
const ALIGN = 16 * 2;
const MIN_TOKENS = 8;
const MAX_TOKENS = 4096;
const MIN_PIXELS = MIN_TOKENS * ALIGN * ALIGN;
const MAX_PIXELS = MAX_TOKENS * ALIGN * ALIGN;
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

/**
 * The size libmtmd would resize a `width` × `height` image to: `img_tool::calc_size_preserved_ratio`
 * ("smart resize") in mtmd-image.cpp, with its `float` arithmetic (`fround`) so that the result is the
 * same number to the pixel. A target the encoder does not recognise as its own is resampled again.
 */
export function engineSize(width: number, height: number): { width: number; height: number } {
  const f = Math.fround;
  const round = (x: number) => Math.round(f(x / ALIGN)) * ALIGN;
  const ceil = (x: number) => Math.ceil(f(x / ALIGN)) * ALIGN;
  const floor = (x: number) => Math.floor(f(x / ALIGN)) * ALIGN;
  let w = Math.max(ALIGN, round(width));
  let h = Math.max(ALIGN, round(height));
  if (h * w > MAX_PIXELS) {
    const beta = f(Math.sqrt(f(f(f(height) * width) / MAX_PIXELS)));
    h = Math.max(ALIGN, floor(f(height / beta)));
    w = Math.max(ALIGN, floor(f(width / beta)));
  } else if (h * w < MIN_PIXELS) {
    const beta = f(Math.sqrt(f(MIN_PIXELS / f(f(height) * width))));
    h = ceil(f(height * beta));
    w = ceil(f(width * beta));
  }
  return { width: w, height: h };
}

/** `file` as an uncompressed PNG, already at the size the encoder takes (`engineSize`). Throws ImageRejected when it is not a JPEG, PNG or WebP image within the limits. */
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
    // `metadata()` reports the size after EXIF orientation, which is also the order the pipeline
    // applies things in (orient, then resize). Cubic is the kernel libmtmd's own resize uses
    // (bicubic, as Pillow); a stretch to the exact size, not "inside", because libmtmd would pad.
    const target = engineSize(width, height);
    if (target.width !== width || target.height !== height) {
      image.resize(target.width, target.height, { filter: "cubic" });
    }
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

// The model files, as tools/fetch_model.sh leaves them; SAT_MODEL_DIR overrides the directory. The checks that run
// inside index-translator's own pipeline also need INDEX_TRANSLATOR, a checkout of it (see REPORT.md).
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "..");
export const MODEL_DIR = resolve(process.env.SAT_MODEL_DIR || join(ROOT, "models", "sat-3l-sm"));
export const MODEL = join(MODEL_DIR, "model.onnx");

/** index-translator's checkout, for the checks against its ONNX Runtime binding and sat.ts. */
export function appDir(): string {
  const dir = process.env.INDEX_TRANSLATOR;
  if (!dir) {
    throw new Error("set INDEX_TRANSLATOR to an index-translator checkout (see REPORT.md, in-app checks)");
  }
  return resolve(dir);
}

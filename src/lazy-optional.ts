// A codec file that may or may not be installed, loaded the first time it is asked for.

import { existsSync } from "node:fs";

/**
 * A codec loaded on first use from `file()`: undefined while the file is not there, or when loading
 * it fails (logged as `failure` and the codec is given up for good). The file's absence is not
 * remembered, so installing it needs no restart.
 */
export function lazyOptional<T>(
  file: () => string,
  load: (file: string) => Promise<T>,
  failure: string,
): () => Promise<T | undefined> {
  let loading: Promise<T | undefined> | undefined;
  return async () => {
    const path = file();
    if (!loading && !existsSync(path)) {
      return;
    }
    loading ??= (async (): Promise<T | undefined> => {
      try {
        return await load(path);
      } catch (e) {
        console.error(`[speech] ${failure}: ${String(e)}`);
      }
    })();
    return loading;
  };
}

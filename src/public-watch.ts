// One recursive watch on the public directory, shared by what must notice a file change: the asset
// manifest (src/static.ts) and, in development, the page reload (src/dev-reload.ts).

import { watch } from "node:fs";

export interface PublicWatcher {
  /** False when the directory cannot be watched; a consumer then cannot know when files change. */
  readonly watching: boolean;
  /** Calls `listener` on every change under the directory (unfiltered and undebounced). */
  subscribe(listener: () => void): void;
  close(): void;
}

export function watchPublic(publicDir: string): PublicWatcher {
  const listeners = new Set<() => void>();
  let watcher: ReturnType<typeof watch> | undefined;
  try {
    watcher = watch(publicDir, { recursive: true }, () => {
      for (const listener of listeners) {
        listener();
      }
    });
  } catch {
    // A missing directory: nothing is served from it either.
  }
  return {
    watching: watcher !== undefined,
    subscribe: (listener) => void listeners.add(listener),
    close() {
      watcher?.close();
      listeners.clear();
    },
  };
}

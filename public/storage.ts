// The browser's local storage, used only for conveniences (the languages, the model, the voice),
// so a browser that refuses it just forgets them.

/** Every key the page keeps; `stored` and `store` take no other. */
export const KEYS = {
  from: "from",
  to: "to",
  model: "model",
  voice: "voice",
  speed: "speed",
  historyPaused: "history-paused",
  history: "history",
} as const;

export type StorageKey = (typeof KEYS)[keyof typeof KEYS];

export function stored(key: StorageKey): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Whether the browser took the value; callers that can do without it ignore the answer. */
export function store(key: StorageKey, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    // storage is only a convenience
    return false;
  }
}

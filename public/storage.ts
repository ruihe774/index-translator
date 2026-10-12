// The browser's local storage, used only for conveniences (the languages, the model, the voice),
// so a browser that refuses it just forgets them.

export function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Whether the browser took the value; callers that can do without it ignore the answer. */
export function store(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    // storage is only a convenience
    return false;
  }
}

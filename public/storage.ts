// The browser's local storage, used only for conveniences (the languages, the model, the voice),
// so a browser that refuses it just forgets them.

export function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage is only a convenience
  }
}

// Whether the source box holds nothing but the address of a web page, which Translate then offers to
// fetch (`POST /webpage`) instead of translating the address. Pure: no DOM access.
//
// Permissive on purpose, since the user is asked first: `https://…` and `http://…`, and without a
// scheme anything shaped like a host name with a top-level domain of letters (`example.com/a`,
// `www.example.org`), which is taken as https. So `Node.js` counts too; the dialog lets it be
// translated as text.

const SCHEME = /^https?:\/\//i;
/** Labels of letters, digits and inner hyphens, dot separated, ending in letters; then a port, a path, a query or a fragment. */
const BARE = /^(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+\p{L}{2,}(?::\d{1,5})?(?:[/?#]\S*)?$/u;

/** The page's address, absolute and normalized, when `text` (trimmed) is one; else null. */
export function webpageLink(text: string): string | null {
  // An address in angle brackets, as in Markdown and e-mail, is still just an address.
  const trimmed = text.trim().replace(/^<(.*)>$/s, "$1");
  if (!trimmed || /\s/.test(trimmed)) {
    return null;
  }
  const candidate = SCHEME.test(trimmed) ? trimmed : BARE.test(trimmed) ? `https://${trimmed}` : null;
  if (!candidate) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  // The server refuses addresses with credentials; such a text is not offered as a page.
  return url.hostname && !url.username && !url.password ? url.href : null;
}

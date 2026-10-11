# Markdown output: CommonMark conformance

The web app renders the translation as Markdown when the source looks like Markdown
(`public/markdown.ts`, drawn by `public/markdown-dom.ts`). The parser is a deliberate subset of
CommonMark plus a few GFM extensions, sized for translated documents and model output, and it must
stay prefix-stable for streaming (see CLAUDE.md). This page lists where it differs from the spec.

## Checking

```sh
bun scripts/commonmark.ts                      # downloads spec.json for CommonMark 0.31.2
bun scripts/commonmark.ts spec.json            # or a local copy
bun scripts/commonmark.ts --show ref-link      # examples of one reason, or by number: --show 23 597
```

The script renders the parse tree as the spec's reference HTML (real heading levels, `<img>`) and
compares it after the spec's whitespace normalisation. It exits 1 if an example fails that is not
listed in its `KNOWN` table, or if a listed one passes, so this page and the table stay accurate.
Update both when the parser changes.

## Result

CommonMark 0.31.2: **390 of 652** examples pass exactly. Of the 262 others, 51 differ only in line
breaks, and 211 come from constructs that are left out on purpose. No divergence is
unexplained.

| Reason | Examples | Behaviour here |
|---|---:|---|
| Line breaks kept | 51 | Every newline inside a paragraph is a line break (`<br>`), not a soft break. Translations keep the source's line structure, as the plain-text view does. |
| Raw HTML | 74 | HTML blocks and inline HTML are shown as text, never interpreted. Model output must not be able to inject markup. |
| Link reference definitions | 75 | `[text][ref]`, `[ref]` and `[ref]: /url` are not supported; they stay text. Only inline links `[text](url)` and autolinks. |
| Indented code blocks | 43 | Four-space indentation is not code; it stays prose, so indented plain text is not turned into code blocks. Fenced code works. Tab examples that fail are indented code too. |
| Entity and character references | 12 | `&ouml;`, `&#35;` and the like are shown as written, not decoded. |
| Autolink schemes | 4 | `<scheme:...>` autolinks only for `http:`, `https:` and `mailto:` (and `<user@host>` e-mail); others stay text. Links to other schemes would not be clickable anyway. |
| GFM bare URLs | 3 | `https://...` in text becomes a link (GFM extended autolinks), which CommonMark does not do. |

Example numbers for each reason are in `KNOWN` in `scripts/commonmark.ts`.

## Differences outside the spec suite

- GFM extensions: pipe tables (with alignment), `~~strikethrough~~` (two tildes only), task list
  items `- [ ]` / `- [x]`, bare URL autolinks. The GFM spec suite has not been run.
- Rendering in the page: Markdown heading levels are shifted down two (`#` becomes `<h3>`) below
  the page's own headings; an `md-h<level>` class keeps the source level for styling. Images are shown
  as links labelled with their alt text and are not loaded. Links open in a new tab and are only
  clickable for `http:`, `https:` and `mailto:` URLs; others are rendered as plain text.
- Streaming: an unclosed code fence drops its trailing blank lines while it is still open. The
  finished output is the same as a parse of the whole text.

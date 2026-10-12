# Windows development (for agents)

What differs when working on this repository on Windows. Everything else is in `CLAUDE.md`.

## Tools

`bun` and `node` are on the user `PATH`; call them by name. Git Bash and PowerShell both work.
There is no `bunx` (Bun's install gives only `bun.exe`); use `npx` (comes with Node) or `bun x`.

## Running the checks

- Unit and integration: `bun test` (all pass; the speech and llama engines are mocked, no GPU or `.dll` needed).
- Typecheck: `bun run typecheck`.
- e2e: run Playwright with Node, not Bun: `node node_modules/@playwright/test/cli.js test`
  (add `--reporter=line` for compact output). `bun run e2e` starts Playwright under Bun, which
  prints nothing and exits 0 without running the tests here; do not trust its result.
- Chromium comes from Playwright's download (`npx playwright install chromium`) or `CHROMIUM_PATH`.
- `bun run check` (Biome) reports errors that are not related to the test suite; they were not triaged.

## Writing tests that pass on Windows

- Paths: `resolve("/m")` is `<current drive>:\m` and `join("/s", "x")` uses backslashes. Compare
  with `resolve()`/`join()`, never with a literal POSIX string.
- Drives: `os.tmpdir()` can be on another drive than the repository, so `relative()` from the
  working directory to a temp directory is absolute, and `/` is the root of the current drive only.
- Native libraries: use `libraryPath()` from `src/audiocpp-ffi.ts` (or `libName` in `src/llama-ffi.ts`)
  for a library's file name, never `lib….so`.
- Clipboard: the Windows clipboard returns `\r\n` for `\n`; normalize before comparing.

## Line endings

Every tracked file is LF. `.gitattributes` enforces it (`eol=lf`), so do not convert files to
CRLF and do not commit CRLF. Editors and `sed -i` in Git Bash keep LF; check with
`git ls-files --eol` (no `w/crlf` or `w/mixed` lines).

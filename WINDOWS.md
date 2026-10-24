# Windows development (for agents)

What differs when working on this repository on Windows. Everything else is in `CLAUDE.md`.

## Tools

`bun` and `node` are on the user `PATH`; call them by name. Git Bash and PowerShell both work.
There is no `bunx` (Bun's install gives only `bun.exe`); use `npx` (comes with Node) or `bun x`.

## Running the checks

- Unit and integration: `bun test` (all pass; the speech and llama engines are mocked, no GPU or `.dll` needed).
- Typecheck: part of `bun run lint:ts`.
- e2e: run Playwright with Node, not Bun: `node node_modules/@playwright/test/cli.js test -c e2e/playwright.config.ts`
  (add `--reporter=line` for compact output). `bun run e2e` starts Playwright under Bun, which
  prints nothing and exits 0 without running the tests here; do not trust its result.
- Chromium comes from Playwright's download (`npx playwright install chromium`) or `CHROMIUM_PATH`.
- `bun run lint:ts` (`bun lint --type-aware --type-check`) reports zero problems on Linux (`maxWarnings = 0` in `bunfig.toml`); it has not been run on Windows since that change.

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

## Building the engines

`bun scripts/build_llama.ts`, `bun scripts/build_audiocpp.ts` and `bun scripts/build_soxr.ts` (libsoxr, as
`soxr.dll`; it needs only Git, CMake, Ninja and the Visual Studio tools) build for Windows with no administrator
rights. They need: Git, CMake and Ninja (both on the PATH; `winget install Ninja-build.Ninja` installs Ninja
for the current user), Visual Studio 2022 or its Build Tools with the "Desktop development with C++" workload
(found with `vswhere`; `vcvars64.bat` supplies `cl`, whose environment the scripts hand to CMake), and the Vulkan
SDK (`glslc`, headers, `vulkan-1.lib`; sets `VULKAN_SDK`). As on Linux, CMake's Ninja generator is used
(single-configuration, `CMAKE_BUILD_TYPE=Release`); a build tree kept with `--keep` from before this (Visual
Studio generator) must be deleted (`vendor/.build`). A terminal opened before the installs needs a restart to see
the new PATH. The GitHub runner image already has Ninja.

- llama.cpp gives `llama.dll`, `mtmd.dll` (image input; not yet built or run on Windows: the shim links `mtmd.lib`
  and takes `stbi_load_from_memory` from it, which `WINDOWS_EXPORT_ALL_SYMBOLS` should export), `ggml*.dll`, `ggml-vulkan.dll`, `ggml-cpu.dll` (AVX2), and `llama-shim.dll`
  (compiled by `cl`; the shim marks its functions `dllexport`). The `.lib` import libraries stay in
  `vendor/llama.cpp` so `--shim` can rebuild the shim. About 100 s on 20 threads.
- audio.cpp gives `audiocpp.dll` (exports only `audiocpp_*`, checked with `dumpbin /exports`), AVX2 code. About 4 min.
  The script applies `scripts/patches/audiocpp-abort.patch` to the checkout with `git apply --ignore-whitespace`
  (line endings of the checkout do not matter); a DLL built before that patch lacks `audiocpp_set_abort_flag`
  and the server says so when speech is first used. The patched build has not been run on Windows yet.
- Checked on an RX 9070 (Vulkan) with the real engines: translation (72 tokens/s), speech in zh, en and ja,
  a voice upload separated by BS-RoFormer (2 s), and speech with that uploaded voice.
- The AppImage script and the CI `appimage` job are Linux-only and were not changed. CI has `test-windows` (lint and typecheck, `bun test`) and `engines-windows` (builds both engines, checks they open and that the server stops with a reason), neither with a GPU or models.

## Building the launcher

`packaging/windows/launcher.c` is a small Win32 window (command links: start the server on a chosen
port, download models, third-party notices, server settings), each running in an ordinary `cmd /k`
console in the repository directory. It finds the repository by walking up from the exe until
`src\server.ts` exists, and takes `bun` from the `PATH`, so keep `launcher.exe` inside the checkout.

- Build: `packaging\windows\build.bat` (from `cmd` or PowerShell; in Git Bash `cmd //c packaging\windows\build.bat`).
  Needs Visual Studio 2022 or its Build Tools with the "Desktop development with C++" workload,
  found with `vswhere`; the script calls `vcvars64.bat` itself, so no Developer Prompt is needed.
- Output: `packaging/windows/launcher.exe` (untracked, listed in `.gitignore`). `launcher.manifest`
  (Common Controls 6 for command links and visual styles, Per-Monitor DPI Awareness V2) is embedded
  by the build; the `.obj` is deleted afterwards.
- Run it by double-clicking. It is not built in CI and has no automated test; check changes by hand
  at more than one display scale (all sizes are 96-dpi units scaled by the window's DPI).

## Building the installer

`bun scripts/build_installer.ts` makes `dist/Index_Translator-Setup-x86_64.exe` with Inno Setup
(`packaging/windows/installer.iss`; the script stages the files in `vendor/.build/installer/stage`).
Windows has no AppImage-style single file, so the installer unpacks the repository layout: `bun.exe`,
`src/`, `public/`, `prompts/`, the engines' DLLs (no `.lib`, no headers) and `launcher.exe`, which
is the shortcut's target. The launcher's commands run in the install directory, and `cmd` finds
`bun.exe` there first, so the user needs no Bun on the `PATH`.

- Needs the two engines built first (`build_llama.ts`, `build_audiocpp.ts`) and `build_soxr.ts`, the web app's PDF
  libraries fetched (`fetch_web_libs.ts`, packed with `public\`), `fetch_onnxruntime.ts` (Microsoft's
  `onnxruntime.dll`, which runs the sentence segmentation model) and the launcher's MSVC
  tools. The script rebuilds `launcher.exe` when `launcher.c` or the manifest is newer, and downloads
  and installs Inno Setup 6.7.3 for the current user (pinned checksum) when `ISCC.exe` is not found.
- Per-user install by default (`%LOCALAPPDATA%\Programs\Index Translator`, no administrator rights),
  so `models\` and `voices\` beside the program stay writable; the "Download models" link fills them.
  The uninstaller removes only what the installer put there, so models and voices stay.
- The Visual C++ runtime (the x64 Redistributable the engines import; `onnxruntime.dll` imports
  `VCRUNTIME140`, `VCRUNTIME140_1`, `MSVCP140` and `MSVCP140_1`, which that same Redistributable provides, so
  nothing more is installed for it; not tested without the Redistributable) is not packed. The installer
  includes `packaging/windows/CodeDependencies.iss` (a copy of DomGries/InnoDependencyInstaller) and
  calls `Dependency_AddVC14`: when the runtime is missing or older than the version the script names,
  the installer downloads Microsoft's redistributable (checksum pinned in that file) and runs it,
  which asks for administrator rights itself. Needs network only on a machine without the runtime.
  The Universal CRT comes with Windows 10 and later. Not tested without the redistributable.
- CI job `installer-windows` builds it (reusing the engine caches), installs it silently, checks that
  the installed `bun.exe` loads the engines and stops with the same reasons as `engines-windows`,
  uninstalls it, and uploads the installer as an artifact. Installing and uninstalling were also run by hand.

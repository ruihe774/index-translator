# Windows development (for agents)

What differs when working on this repository on Windows. Everything else is in `CLAUDE.md`.

## Tools

`bun` and `node` are on the user `PATH`; call them by name. Git Bash and PowerShell both work.
There is no `bunx` (Bun's install gives only `bun.exe`); use `npx` (comes with Node) or `bun x`.

## Running the checks

- Unit and integration: `bun test` (all pass; the speech and llama engines are mocked, no GPU or `.dll` needed).
- Typecheck: part of `bun run lint:ts`.
- e2e: run Playwright with Node, not Bun: `node node_modules/@playwright/test/cli.js test -c e2e/playwright.config.ts`
  (add `--project=chromium` for one browser). `bun run e2e` starts Playwright under Bun, which
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

The engines and their libraries are built with Zig, as on Linux: `bun scripts/fetch_zig.ts` (Zig into `vendor/zig`),
then `bun scripts/zigbuild_llamacpp.ts`, `bun scripts/zigbuild_audiocpp.ts`, `bun scripts/zigbuild_soxr.ts` and
`bun scripts/zigbuild_libopus.ts`, for the target `x86_64-windows-gnu`
(`scripts/zig/zig-toolchain-x86_64-windows-gnu.cmake`: MinGW-w64 with UCRT, libc++ linked in, x86-64-v3). No
administrator rights. They need Git, CMake and Ninja on the PATH (their standalone installers, or
`winget install Git.Git Kitware.CMake Ninja-build.Ninja`; the scripts do not look for them elsewhere, Visual Studio's
copies included) and, for the engines, the Vulkan SDK (`glslc`, the headers, `vulkan-1.lib`; the toolchain file takes
the library from `VULKAN_SDK`, which the engine scripts require), no C or C++ compiler and no Visual Studio. A
terminal opened before the installs needs a restart to see the new PATH.

- llama.cpp gives one `llama.dll`: libllama, libmtmd, the shim, ggml, its Vulkan and CPU backends. Nothing in it is
  marked `dllexport` (llama.h under MinGW, and the shim likewise), so the linker exports every symbol; a single
  `dllexport` would leave only that one's. The DLL imports only KERNEL32, ADVAPI32, the UCRT (`api-ms-win-crt-*`,
  part of Windows 10 and later) and `vulkan-1.dll`. `--shim` relinks it from a tree kept with `--keep`.
- audio.cpp gives `audiocpp.dll` (CMake's MinGW name `libaudiocpp.dll`, renamed when copied; it exports only
  `audiocpp_*`, which audio.cpp marks `dllexport`), with the same imports. The script applies the patches in
  `scripts/patches/` with `git apply --ignore-whitespace`.
- `-flto=thin` is on the compile lines only: on a link (CMake repeats the compile flags there) Zig 0.17.1 would build
  its MinGW libc as bitcode too and miss its own math and string functions, so the toolchain file adds `-fno-lto`
  to the link flags. The objects are bitcode either way, and the linker optimizes them together.
- A checkout whose files are dated in the future (a system clock that was ahead) makes Ninja regenerate the shader
  generator's build forever ("build.ninja still dirty after 100 tries"): its build depends on the toolchain files.
  `touch` them.

- libsoxr gives `soxr.dll` and libopus `opus.dll` (CMake's MinGW names `libsoxr.dll` and `libopus.dll`, renamed when
  copied: audio.cpp asks for `soxr.dll` by name). Each exports its own functions and three symbols of MinGW's
  start-up code, and imports only KERNEL32 and the UCRT. These Zig builds were cross-built from Linux and checked
  there, not yet run on Windows (the speech check below used the earlier MSVC builds).
- Checked on an RX 9070 (Vulkan, Vulkan SDK 1.4.363.0) and an i5-14600KF with the Zig builds and the real models:
  text translation with MTP (115 tokens/s; the earlier MSVC build gave 72 without it), an opaque and a transparent
  image, `POST /segment`, `POST /align` (LaBSE on llama.dll's CPU backend), speech in en, and transcription of that
  speech with and without Mel-Band RoFormer separation. The builds took 90 s (llama.cpp) and 114 s (audio.cpp) on
  20 threads.
- The AppImage script and the CI `appimage` job are Linux-only. CI has `test-windows` (lint and typecheck, `bun test`)
  and `engines-windows` (fetches Zig, builds both engines against the Vulkan SDK of Ubuntu 26.04's version, 1.4.341.0,
  and libsoxr, checks they open, that audio.cpp's lookup of `soxr.dll` finds ours and that the server stops with a
  reason), neither with a GPU or models.

## Building the launcher

`packaging/windows/launcher.c` is a small Win32 window (command links: start the server on a chosen
port, download models, third-party notices, server settings), each running in an ordinary `cmd /k`
console in the repository directory. It finds the repository by walking up from the exe until
`src\server.ts` exists, and takes `bun` from the `PATH`, so keep `launcher.exe` inside the checkout.

- Build: `bun scripts/zigbuild_launcher.ts`. Zig only (`bun scripts/fetch_zig.ts`): `zig cc` for `x86_64-windows-gnu`
  (MinGW-w64 with UCRT, as the engines) with `-municode` and the GUI subsystem, `launcher.rc` compiled by Zig's
  resource compiler. No CMake, Ninja or Visual Studio, and no Visual C++ runtime at run time.
- Output: `packaging/windows/launcher.exe` (untracked, listed in `.gitignore`). `launcher.rc` holds the icon and
  `launcher.manifest` (Common Controls 6 for command links and visual styles, Per-Monitor DPI Awareness V2) as the
  exe's manifest resource.
- Run it by double-clicking. It is not built in CI and has no automated test; check changes by hand
  at more than one display scale (all sizes are 96-dpi units scaled by the window's DPI).

## Building the installer

`bun scripts/build_installer.ts` makes `dist/Index_Translator-Setup-x86_64.exe` with Inno Setup
(`packaging/windows/installer.iss`; the script stages the files in `vendor/.build/installer/stage`).
Windows has no AppImage-style single file, so the installer unpacks the repository layout: `bun.exe`,
`src/`, `public/`, `prompts/`, the engines' DLLs (no `.lib`, no headers) and `launcher.exe`, which
is the shortcut's target. The launcher's commands run in the install directory, and `cmd` finds
`bun.exe` there first, so the user needs no Bun on the `PATH`.

- Needs the two engines built first (`zigbuild_llamacpp.ts`, `zigbuild_audiocpp.ts`), `zigbuild_sat_engine.ts` (the
  sentence segmentation model's forward pass), `zigbuild_soxr.ts`, `zigbuild_libopus.ts` and `build_bun.ts` (the packed `bun.exe`, a minimal build of Bun; it needs LLVM 23.1, NASM and Perl beside Visual
  Studio, see the head of the script; Visual Studio is needed for nothing else here), the web app's PDF
  libraries fetched (`fetch_web_libs.ts`, packed with `public\`). The script runs `zigbuild_launcher.ts` when `launcher.c`, `launcher.rc`
  or the manifest is newer than `launcher.exe`, and downloads
  and installs Inno Setup 6.7.3 for the current user (pinned checksum) when `ISCC.exe` is not found.
- Per-user install by default (`%LOCALAPPDATA%\Programs\Index Translator`, no administrator rights),
  so `models\` and `voices\` beside the program stay writable; the "Download models" link fills them.
  The uninstaller removes only what the installer put there, so models and voices stay.
- The Visual C++ runtime is neither packed nor installed. The engines, `soxr.dll` and `opus.dll` (built with Zig, which
  links MinGW-w64 against the Universal CRT), the minimal `bun.exe` and `launcher.exe` import only Windows' own DLLs
  and the Universal CRT (`api-ms-win-crt-*`), which comes with Windows 10 and later; none imports `vcruntime140.dll`,
  `msvcp140.dll` or `vcomp140.dll` (checked with `llvm-objdump -p`). The installer needs no network.
- CI job `bun-windows` builds `bun.exe` (cached by the script and the patch) and checks it with `scripts/check_bun.ts`.
- CI job `installer-windows` builds it (reusing the engine caches and `bun-windows`'), installs it silently, checks that
  the installed `bun.exe` loads the engines and stops with the same reasons as `engines-windows`,
  uninstalls it, and uploads the installer as an artifact. Installing and uninstalling were also run by hand.

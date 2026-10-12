/* Index Translator launcher: a small Win32 window whose command links run the subcommands in an
   ordinary console window (cmd /k, so the output stays readable after the command ends). Nothing
   else: no status tracking, no embedding. Finds the repository by walking up from the exe until
   src\server.ts exists; `bun` comes from PATH.
   Modern look: Common Controls 6 (command links, visual styles) and Per-Monitor DPI Awareness V2,
   both declared in launcher.manifest, which build.bat embeds. All sizes are in 96-dpi units and
   scaled by the window's DPI; WM_DPICHANGED rebuilds the font and the layout.
   Build: packaging\windows\build.bat (MSVC). */
#define UNICODE
#define _UNICODE
#define WINVER 0x0A00
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <commctrl.h>
#include <stdio.h>
#include <wchar.h>

#pragma comment(lib, "comctl32.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")

enum { ID_PORT_LABEL = 100, ID_PORT, ID_START, ID_FETCH, ID_NOTICES, ID_HELP, ID_QUIT };

/* 96-dpi layout */
enum { MARGIN = 24, CLIENT_W = 400, ROW_H = 28, LINK_H = 62, GAP = 10, BTN_W = 110, BTN_H = 32 };

static const struct { int id; const WCHAR *title, *note; } links[] = {
  {ID_START, L"Start translator", L"Run the server and open it in the browser"},
  {ID_FETCH, L"Download models", L"Fetch the translation and speech models (about 17.7 GiB)"},
  {ID_NOTICES, L"Third-party notices", L"Licenses of the bundled software"},
  {ID_HELP, L"Server settings", L"List every flag and environment variable"},
};
#define NLINKS (int)(sizeof links / sizeof links[0])

static WCHAR root[MAX_PATH];
static HFONT font;

static int find_root(void) {
  WCHAR p[MAX_PATH], f[MAX_PATH];
  if (!GetModuleFileNameW(NULL, p, MAX_PATH)) return 0;
  for (;;) {
    WCHAR *s = wcsrchr(p, L'\\');
    if (!s) return 0;
    *s = 0;
    swprintf(f, MAX_PATH, L"%s\\src\\server.ts", p);
    if (GetFileAttributesW(f) != INVALID_FILE_ATTRIBUTES) {
      wcscpy(root, p);
      return 1;
    }
  }
}

/* Run `cmd /k <line>` in a new console, in the repository directory. */
static void run(HWND owner, const WCHAR *line) {
  WCHAR cmd[2048];
  swprintf(cmd, 2048, L"cmd.exe /k %s", line);
  STARTUPINFOW si = {sizeof si};
  PROCESS_INFORMATION pi;
  if (CreateProcessW(NULL, cmd, NULL, NULL, FALSE, CREATE_NEW_CONSOLE, NULL, root, &si, &pi)) {
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
  } else {
    MessageBoxW(owner, L"Could not start cmd.exe.", L"Index Translator", MB_ICONERROR);
  }
}

static int px(int v, UINT dpi) { return MulDiv(v, dpi, 96); }

static BOOL CALLBACK set_font(HWND c, LPARAM f) {
  SendMessageW(c, WM_SETFONT, (WPARAM)f, TRUE);
  return TRUE;
}

/* The system message font (Segoe UI Variable on Windows 11) at this DPI. */
static void make_font(HWND w, UINT dpi) {
  NONCLIENTMETRICSW m = {sizeof m};
  SystemParametersInfoForDpi(SPI_GETNONCLIENTMETRICS, sizeof m, &m, 0, dpi);
  HFONT old = font;
  font = CreateFontIndirectW(&m.lfMessageFont);
  EnumChildWindows(w, set_font, (LPARAM)font);
  if (old) DeleteObject(old);
}

static void layout(HWND w, UINT dpi) {
  int cw = CLIENT_W - 2 * MARGIN, y = MARGIN;
  MoveWindow(GetDlgItem(w, ID_PORT_LABEL), px(MARGIN, dpi), px(y + 4, dpi), px(60, dpi), px(ROW_H - 8, dpi), TRUE);
  MoveWindow(GetDlgItem(w, ID_PORT), px(MARGIN + 64, dpi), px(y, dpi), px(80, dpi), px(ROW_H, dpi), TRUE);
  y += ROW_H + GAP + 6;
  for (int i = 0; i < NLINKS; i++, y += LINK_H + GAP)
    MoveWindow(GetDlgItem(w, links[i].id), px(MARGIN, dpi), px(y, dpi), px(cw, dpi), px(LINK_H, dpi), TRUE);
  y += 6;
  MoveWindow(GetDlgItem(w, ID_QUIT), px(CLIENT_W - MARGIN - BTN_W, dpi), px(y, dpi), px(BTN_W, dpi), px(BTN_H, dpi), TRUE);
}

static int client_height(void) {
  return MARGIN + ROW_H + GAP + 6 + NLINKS * (LINK_H + GAP) + 6 + BTN_H + MARGIN;
}

static void fit_window(HWND w, UINT dpi) {
  RECT r = {0, 0, px(CLIENT_W, dpi), px(client_height(), dpi)};
  AdjustWindowRectExForDpi(&r, WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU, FALSE, 0, dpi);
  SetWindowPos(w, NULL, 0, 0, r.right - r.left, r.bottom - r.top, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
}

static LRESULT CALLBACK proc(HWND w, UINT m, WPARAM wp, LPARAM lp) {
  switch (m) {
    case WM_CREATE: {
      CreateWindowW(L"STATIC", L"Port", WS_CHILD | WS_VISIBLE, 0, 0, 0, 0, w, (HMENU)ID_PORT_LABEL, NULL, NULL);
      HWND e = CreateWindowExW(WS_EX_CLIENTEDGE, L"EDIT", L"3000", WS_CHILD | WS_VISIBLE | WS_TABSTOP | ES_NUMBER | ES_CENTER,
                               0, 0, 0, 0, w, (HMENU)ID_PORT, NULL, NULL);
      SendMessageW(e, EM_LIMITTEXT, 5, 0);
      for (int i = 0; i < NLINKS; i++) {
        HWND b = CreateWindowW(L"BUTTON", links[i].title,
                               WS_CHILD | WS_VISIBLE | WS_TABSTOP | (i == 0 ? BS_DEFCOMMANDLINK : BS_COMMANDLINK),
                               0, 0, 0, 0, w, (HMENU)(INT_PTR)links[i].id, NULL, NULL);
        SendMessageW(b, BCM_SETNOTE, 0, (LPARAM)links[i].note);
      }
      CreateWindowW(L"BUTTON", L"Close", WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
                    0, 0, 0, 0, w, (HMENU)ID_QUIT, NULL, NULL);
      UINT dpi = GetDpiForWindow(w);
      make_font(w, dpi);
      layout(w, dpi);
      return 0;
    }
    case WM_CTLCOLORSTATIC: /* the label sits on the window's own background */
      SetBkMode((HDC)wp, TRANSPARENT);
      return (LRESULT)GetSysColorBrush(COLOR_WINDOW);
    case WM_DPICHANGED: {
      UINT dpi = HIWORD(wp);
      const RECT *r = (const RECT *)lp;
      make_font(w, dpi);
      layout(w, dpi);
      SetWindowPos(w, NULL, r->left, r->top, r->right - r->left, r->bottom - r->top, SWP_NOZORDER | SWP_NOACTIVATE);
      return 0;
    }
    case WM_COMMAND:
      if (HIWORD(wp) != BN_CLICKED) break;
      switch (LOWORD(wp)) {
        case ID_START: {
          WCHAR port[8] = L"", line[256];
          GetDlgItemTextW(w, ID_PORT, port, 8);
          if (!port[0]) wcscpy(port, L"3000");
          swprintf(line, 256, L"bun --no-env-file src\\server.ts --port %s", port);
          run(w, line);
          break;
        }
        case ID_FETCH:
          run(w, L"bun --no-env-file scripts\\fetch_models.ts");
          break;
        case ID_NOTICES:
          run(w, L"type THIRD_PARTY_NOTICES.md | more");
          break;
        case ID_HELP:
          run(w, L"bun --no-env-file src\\server.ts --help");
          break;
        case ID_QUIT:
          DestroyWindow(w);
          break;
      }
      return 0;
    case WM_DESTROY:
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(w, m, wp, lp);
}

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE prev, PWSTR args, int show) {
  (void)prev; (void)args;
  INITCOMMONCONTROLSEX ic = {sizeof ic, ICC_STANDARD_CLASSES};
  InitCommonControlsEx(&ic);
  if (!find_root()) {
    MessageBoxW(NULL, L"Could not find the repository (src\\server.ts above this program).",
                L"Index Translator", MB_ICONERROR);
    return 1;
  }
  WNDCLASSW wc = {0};
  wc.lpfnWndProc = proc;
  wc.hInstance = inst;
  wc.hCursor = LoadCursorW(NULL, IDC_ARROW);
  wc.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);
  wc.lpszClassName = L"IndexTranslatorLauncher";
  RegisterClassW(&wc);
  HWND w = CreateWindowW(wc.lpszClassName, L"Index Translator", WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU,
                         CW_USEDEFAULT, CW_USEDEFAULT, 100, 100, NULL, NULL, inst, NULL);
  fit_window(w, GetDpiForWindow(w));
  ShowWindow(w, show);
  MSG msg;
  while (GetMessageW(&msg, NULL, 0, 0) > 0) {
    if (!IsDialogMessageW(w, &msg)) {
      TranslateMessage(&msg);
      DispatchMessageW(&msg);
    }
  }
  return 0;
}

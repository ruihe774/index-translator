# Accessibility acceptance report

- **Standard:** WCAG 2.2 Level AA (a11y-acceptance skill, criteria A11Y-01…51)
- **Scope:** full: the single-page web app in `public/` (`index.html`, `style.css`, `app.ts`, `select-model.ts`)
- **Date:** 2026-10-10
- **Tools run:** `a11y_check.py lint public` → 0 FAIL, 1 WARN (see A11Y-17); `a11y_check.py contrast` on every colour pair in `style.css`, light and dark; no browser or axe-core run (skipped on request, to be done in another session)
- **Summary:** 30 PASS · 0 FAIL · 15 N/A · 0 BLOCKED · 6 UNVERIFIED

Status values: `PASS` · `FAIL` · `N/A (reason)` · `BLOCKED (what is needed)` · `UNVERIFIED (why)`.
BP rows (best practice) never block acceptance.

| ID | Criterion | Status | Evidence |
|----|-----------|--------|----------|
| A11Y-01 | Page language | PASS | `<html lang="en">`, index.html:2; lint |
| A11Y-02 | Language of parts | PASS | Chinese genre examples wrapped in `<span lang="zh">` (index.html, `genre-hint`); `#output` gets `lang` = target language code in `translate()` (app.ts); model names are proper nouns |
| A11Y-03 | Page title | PASS | One `<title>`: "Translate – Index Translator"; single-page site |
| A11Y-04 | Landmarks | PASS | One `<main id="main">`, `<header>`, `<footer>`; no `<nav>`; the "Translation" `<section>` is named by `aria-labelledby`; lint |
| A11Y-05 | Headings | PASS | `h1` "Index Translator", `h2` "Translation"; nothing else styled as a heading |
| A11Y-06 | Semantic structure | PASS | Result notes are a `<ul>`; radio group is `fieldset`/`legend`; no tables |
| A11Y-07 | Meaningful sequence & sensory cues | PASS | DOM order equals visual order, no CSS `order` or absolute layout (only the skip link); no instruction refers to shape, position or colour |
| A11Y-08 | Valid ARIA & IDs | PASS | lint: no FAIL; ids unique; every `aria-describedby`/`for` target exists; only `role="status"`/`"alert"` added, plus `aria-required`, `aria-invalid`, `aria-disabled` |
| A11Y-09 | Images | N/A (no images) | |
| A11Y-10 | SVG & icons | N/A (no SVG or icon fonts) | |
| A11Y-11 | Prerecorded media alternatives | N/A (no media) | |
| A11Y-12 | Live media | N/A (no live media) | |
| A11Y-13 | Keyboard operable | PASS | Only native `button`, `a[href]`, `select`, `input`, `textarea`, `details`; the single `click` handler is on a `<button>` (Copy); Stop is a `<button>` |
| A11Y-14 | No keyboard trap | PASS | No `keydown`/`keypress` handlers, iframes, dialogs or custom widgets (grep of `public/`) |
| A11Y-15 | Character key shortcuts | PASS | No shortcuts defined (no key handlers) |
| A11Y-16 | Focus order | PASS | No `tabindex` > 0; the only `tabindex` is `-1` on `<main>` (skip-link target); Stop button uses `hidden` while inactive; source order = visual order |
| A11Y-17 | Visible focus | UNVERIFIED (needs browser) | Static part holds: `:focus-visible { outline: 3px solid var(--focus) }` for all controls; ring colour vs bg 6.38:1 (light), 8.88:1 (dark), vs surface 5.8:1 / 7.88:1. The one lint WARN is `main:focus { outline: none }`, which only applies to programmatic focus on a `tabindex="-1"` element that is not in the tab order. Rendered check of the ring not run |
| A11Y-18 | Focus not obscured | PASS | No `position: sticky`/`fixed` content (grep of `style.css`); skip link is the only positioned element and is on screen only while focused |
| A11Y-19 | Bypass blocks (skip link) | PASS | `<a class="skip-link" href="#main">` is the first focusable element, becomes visible on `:focus`, targets `<main id="main" tabindex="-1">` |
| A11Y-20 | Dialog/menu focus management | UNVERIFIED (needs browser) | No dialogs or menus; the advanced section is a native `<details>`. On Translate, focus moves to Stop and returns to Translate when the run ends (`setRunning`, `translate()` `finally` in app.ts); this hand-off was not exercised |
| A11Y-21 | Text contrast | PASS | Measured with `a11y_check.py contrast`, light/dark: text/bg 17.4/15.85, muted/bg 7.55/9.5, muted/surface 6.86/8.43, text/surface 15.81/14.06, link/bg 6.38/8.88, link/surface 5.8/7.88, on-accent/accent 6.38/8.24, error/bg 6.53/8.2, warn text/warn bg 10.64/11.09. No placeholders; disabled text excluded. All ≥ 4.5:1 |
| A11Y-22 | Non-text contrast | PASS | Control and fieldset border vs bg 4.83 / 5.91, vs surface 4.39 / 5.24; warning border vs bg 5.54 / 7.74; focus ring as above. All ≥ 3:1. Radio buttons are native |
| A11Y-23 | Use of color | PASS | Warnings begin with the word "Warning:" and have a border, errors are text, required is stated in the label text, links are underlined |
| A11Y-24 | Zoom & resize text | UNVERIFIED (needs browser) | Static part holds: viewport meta has no `user-scalable`/`maximum-scale`; sizes in `rem`. 200 % zoom not run |
| A11Y-25 | Reflow (320 px) | UNVERIFIED (needs browser) | Layout is flex with wrapping, `max-width` + `width: 100%`, `overflow-wrap: anywhere` on output; not rendered at 320 px |
| A11Y-26 | Text spacing | UNVERIFIED (needs browser) | No fixed heights on text containers (`min-height` only); override not applied |
| A11Y-27 | Images of text | PASS | No images |
| A11Y-28 | Orientation | PASS | No orientation lock in CSS or JS |
| A11Y-29 | Content on hover/focus | N/A (no hover or focus popups, no `title` attributes) | |
| A11Y-30 | Labels | PASS | Every `select`, `input`, `textarea` has a visible `<label for>`; model radios are in `fieldset` + `legend` "Model"; no placeholder-only labels; lint |
| A11Y-31 | Input purpose (autocomplete) | N/A (no fields collecting data about the user) | |
| A11Y-32 | Instructions & required fields | PASS | Label reads "Text to translate (required)" and `required` + `aria-required="true"` are set; glossary format and other hints are linked with `aria-describedby` |
| A11Y-33 | Error identification & suggestion | UNVERIFIED (needs browser) | Implemented: empty text → `text-error` message, `aria-invalid`, focus on the field; bad glossary line → message naming the line and the expected form `source term = target term`, `aria-invalid`, focus, `<details>` opened (app.ts `translate()`, `showFieldError`). Behaviour not exercised |
| A11Y-34 | Status messages | PASS | `#engine` and `#progress` are `role="status"`, `#error` is `role="alert"`; all exist empty or populated in the HTML before any content is injected. The translation output itself is deliberately not a live region (no per-token announcements); completion is announced through `#progress`. Screen reader output not heard |
| A11Y-35 | Predictable on focus/input | PASS | Changing a select, radio or text only refreshes the displayed model explanation; submitting needs the Translate button |
| A11Y-36 | Error prevention | N/A (no legal, financial or data-modifying submissions) | |
| A11Y-37 | Redundant entry & accessible authentication | N/A (no multi-step entry, no authentication; paste is not blocked) | |
| A11Y-38 | Accessible names | PASS | Buttons "Translate", "Stop", "Copy translation" and links have visible text as their names; lint |
| A11Y-39 | Link purpose | PASS | "API specification", "Engine health (JSON)" |
| A11Y-40 | Custom widgets follow APG | N/A (no custom widgets; `details`, `fieldset`/radio, `select` are native) | |
| A11Y-41 | Consistent help | N/A (single page, no help mechanism) | |
| A11Y-42 | Target size | PASS | `button`, `input`, `select`, `textarea`, `summary` have `min-height: 2.75rem` (44 px); radios 1.5rem (24 px) inside 2.75rem rows; footer links are inline text. From CSS values, not measured in a browser |
| A11Y-43 | Gestures & dragging | N/A (none) | |
| A11Y-44 | Pointer cancellation | PASS | Actions use `submit`/`click` only; no `mousedown`/`touchstart` |
| A11Y-45 | Pause, stop, hide | PASS | Nothing moves or blinks. The engine status is refreshed on load, on return to the tab and after each translation; it repeats automatically only while a model load is in progress (2 s), not as a standing timer |
| A11Y-46 | Flashes | PASS | No flashing content |
| A11Y-47 | Reduced motion (BP) | PASS | No animations or transitions in `style.css` |
| A11Y-48 | Timing & audio control | N/A (no time limits, no audio) | |
| A11Y-49 | Consistent navigation & identification | N/A (single page) | |
| A11Y-50 | Multiple ways | N/A (single page) | |
| A11Y-51 | SPA route changes | N/A (no client-side routing) | |

## Open items

All need a browser; to be done in another session (skipped on request).

- **A11Y-17**: confirm in a browser that every control shows the 3 px focus ring in light and dark mode. Owner: whoever runs the browser session.
- **A11Y-20**: confirm focus moves Translate → Stop on start and back to Translate on finish, Stop, or error.
- **A11Y-24**: check at 200 % zoom that nothing is clipped.
- **A11Y-25**: check at 320 px width that nothing needs horizontal scrolling.
- **A11Y-26**: apply the 1.5 / 2 / 0.12 em / 0.16 em text-spacing override and check for clipping.
- **A11Y-33**: submit empty text and a malformed glossary line; check focus, message and `aria-invalid`.
- **Also run** axe-core against the page, and listen once to the `role="status"` / `role="alert"` regions with a screen reader. Some PASS rows (A11Y-21, 22, 34, 42) rest on source and measured token colours, not on a rendered page.

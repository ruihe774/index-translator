# Accessibility acceptance report

- **Standard:** WCAG 2.2 Level AA (a11y-acceptance skill, criteria A11Y-01…51)
- **Scope:** full: the single-page web app in `public/` (`index.html`, `style.css`, `app.ts`, `select-model.ts`)
- **Date:** 2026-10-10
- **Tools run:**
  - `a11y_check.py lint public` → 0 FAIL, 0 WARN (after the `main:focus` fix, A11Y-17)
  - `a11y_check.py contrast` on every colour pair in `style.css`, light and dark
  - Browser (Claude in-app browser, `http://localhost:3000/`, launch config `.claude/launch.json`): keyboard Tab order and focus rings in light and dark; a real translation run (success and Stop); empty-text and malformed-glossary validation; 320 px and 640 px viewports (the 640 px check stands in for 200 % zoom); text-spacing override
  - axe-core 4.10.2 (cdnjs) injected into the rendered page, WCAG 2.0/2.1/2.2 A and AA rule sets, in dark and light: 0 violations
- **Known limits:** 200 % zoom is emulated by a 640 CSS px viewport (same reflow as 200 % zoom on a 1280 px display), not by the browser's zoom control. The screen reader check is not done (see Open items).
- **Summary:** 36 PASS · 0 FAIL · 15 N/A · 0 BLOCKED · 0 UNVERIFIED

Status values: `PASS` · `FAIL` · `N/A (reason)` · `BLOCKED (what is needed)` · `UNVERIFIED (why)`.
BP rows (best practice) never block acceptance.

| ID | Criterion | Status | Evidence |
|----|-----------|--------|----------|
| A11Y-01 | Page language | PASS | `<html lang="en">`, index.html:2; lint |
| A11Y-02 | Language of parts | PASS | Chinese genre examples wrapped in `<span lang="zh">` (index.html, `genre-hint`); `#output` gets `lang` = target language code in `translate()` (app.ts); model names are proper nouns |
| A11Y-03 | Page title | PASS | One `<title>`: "Translate – Index Translator"; single-page site |
| A11Y-04 | Landmarks | PASS | One `<main id="main">`, `<header>`, `<footer>`; no `<nav>`; the "Translation" `<section>` is named by `aria-labelledby`; lint; axe `region` clean |
| A11Y-05 | Headings | PASS | `h1` "Index Translator", `h2` "Translation"; nothing else styled as a heading |
| A11Y-06 | Semantic structure | PASS | Result notes are a `<ul>`; radio group is `fieldset`/`legend`; no tables |
| A11Y-07 | Meaningful sequence & sensory cues | PASS | DOM order equals visual order, no CSS `order` or absolute layout (only the skip link); no instruction refers to shape, position or colour |
| A11Y-08 | Valid ARIA & IDs | PASS | lint: no FAIL; ids unique; every `aria-describedby`/`for` target exists; axe: 0 violations; only `role="status"`/`"alert"` added, plus `aria-required`, `aria-invalid`, `aria-disabled` |
| A11Y-09 | Images | N/A (no images) | |
| A11Y-10 | SVG & icons | N/A (no SVG or icon fonts) | |
| A11Y-11 | Prerecorded media alternatives | N/A (no media) | |
| A11Y-12 | Live media | N/A (no live media) | |
| A11Y-13 | Keyboard operable | PASS | Only native `button`, `a[href]`, `select`, `input`, `textarea`, `details`; the single `click` handler is on a `<button>` (Copy); Stop is a `<button>`; every control reached and operated with Tab/Enter in the browser |
| A11Y-14 | No keyboard trap | PASS | No `keydown`/`keypress` handlers, iframes, dialogs or custom widgets (grep of `public/`); Tab moved through every control in the browser |
| A11Y-15 | Character key shortcuts | PASS | No shortcuts defined (no key handlers) |
| A11Y-16 | Focus order | PASS | No `tabindex` > 0; the only `tabindex` is `-1` on `<main>` (skip-link target); Stop button uses `hidden` while inactive; source order = visual order; browser Tab order: skip link, From, To, text, model radios, Glossary summary, Translate, API spec, Engine health |
| A11Y-17 | Visible focus | PASS | Browser, real Tab presses, light and dark: `:focus-visible` matches and computes `solid 3px` ring on skip link, `a`, both selects, textarea, the three model radios, the Glossary summary, Translate (light `#0b57d0`, dark `#8ab4f8`). Stop and Copy are hidden while idle, so not checked in that state. Found and fixed: `main:focus { outline: none }` removed the indicator when the skip link moved focus to `<main>`; rule deleted (style.css), now shows the 3 px ring (re-verified in browser). Ring contrast: 6.38:1 vs bg and 5.8:1 vs surface (light), 8.88:1 and 7.88:1 (dark). Glossary/hard/soft textareas inside the closed `<details>` were checked by the same rule in source only |
| A11Y-18 | Focus not obscured | PASS | No `position: sticky`/`fixed` content (grep of `style.css`); skip link is the only positioned element and is on screen only while focused |
| A11Y-19 | Bypass blocks (skip link) | PASS | `<a class="skip-link" href="#main">` is the first focusable element (confirmed by Tab in browser), becomes visible on `:focus`, activating it moves focus to `<main id="main" tabindex="-1">` |
| A11Y-20 | Dialog/menu focus management | PASS | No dialogs or menus; the advanced section is a native `<details>`. Browser: on Translate, focus is on Stop while running and returns to Translate when the run ends (`Done.`); on Stop, focus moves Stop → Translate (`Stopped.`). The error branch of `translate()` `finally` is read in source but not exercised |
| A11Y-21 | Text contrast | PASS | Measured with `a11y_check.py contrast`, light/dark: text/bg 17.4/15.85, muted/bg 7.55/9.5, muted/surface 6.86/8.43, text/surface 15.81/14.06, link/bg 6.38/8.88, link/surface 5.8/7.88, on-accent/accent 6.38/8.24, error/bg 6.53/8.2, warn text/warn bg 10.64/11.09. No placeholders; disabled text excluded. All ≥ 4.5:1. Rendered body colours in dark: `rgb(236,236,236)` on `rgb(18,18,18)` (matches tokens) |
| A11Y-22 | Non-text contrast | PASS | Control and fieldset border vs bg 4.83 / 5.91, vs surface 4.39 / 5.24; warning border vs bg 5.54 / 7.74; focus ring as above. All ≥ 3:1. Radio buttons are native |
| A11Y-23 | Use of color | PASS | Warnings begin with the word "Warning:" and have a border, errors are text, required is stated in the label text, links are underlined |
| A11Y-24 | Zoom & resize text | PASS | Static: viewport meta has no `user-scalable`/`maximum-scale`; sizes in `rem` (root 16 px). Browser at 640 CSS px (200 % equivalent): `scrollWidth` = 640 = viewport, no element extends past the viewport, glossary/genre fields and buttons laid out. Emulated viewport, not the browser zoom control |
| A11Y-25 | Reflow (320 px) | PASS | Browser at 320 px: `scrollWidth` = 320 = `clientWidth`, no element past the viewport; screenshot shows the full form in one column, nothing lost |
| A11Y-26 | Text spacing | PASS | Browser: injected override `line-height 1.5`, `letter-spacing .12em`, `word-spacing .16em`, paragraph/label spacing 2em, at 320 px: no horizontal overflow, no clipped element; the only element with overflowing content is the `#text` textarea, which scrolls by design; `min-height` only on text containers |
| A11Y-27 | Images of text | PASS | No images |
| A11Y-28 | Orientation | PASS | No orientation lock in CSS or JS |
| A11Y-29 | Content on hover/focus | N/A (no hover or focus popups, no `title` attributes) | |
| A11Y-30 | Labels | PASS | Every `select`, `input`, `textarea` has a visible `<label for>`; model radios are in `fieldset` + `legend` "Model"; no placeholder-only labels; lint; axe `label` clean |
| A11Y-31 | Input purpose (autocomplete) | N/A (no fields collecting data about the user) | |
| A11Y-32 | Instructions & required fields | PASS | Label reads "Text to translate (required)" and `required` + `aria-required="true"` are set; glossary format and other hints are linked with `aria-describedby` |
| A11Y-33 | Error identification & suggestion | PASS | Browser, empty text + Translate: focus on `#text`, `aria-invalid="true"`, `aria-describedby` = `text-error`, visible "Enter some text to translate." Browser, glossary line "this line has no equals sign": focus on `#glossary`, `aria-invalid="true"`, `aria-describedby` = `glossary-hint glossary-error` → "Glossary line 1 must look like: source term = target term.", `<details>` opened |
| A11Y-34 | Status messages | PASS | `#engine` and `#progress` are `role="status"`, `#error` is `role="alert"`; all exist empty or populated in the HTML before any content is injected. Browser: `#progress` reads "Done." / "Stopped." after a run. The translation output itself is deliberately not a live region (no per-token announcements). Screen reader output not heard |
| A11Y-35 | Predictable on focus/input | PASS | Changing a select, radio or text only refreshes the displayed model explanation; submitting needs the Translate button |
| A11Y-36 | Error prevention | N/A (no legal, financial or data-modifying submissions) | |
| A11Y-37 | Redundant entry & accessible authentication | N/A (no multi-step entry, no authentication; paste is not blocked) | |
| A11Y-38 | Accessible names | PASS | Buttons "Translate", "Stop", "Copy translation" and links have visible text as their names; lint; axe `button-name`, `link-name` clean |
| A11Y-39 | Link purpose | PASS | "API specification", "Engine health (JSON)" |
| A11Y-40 | Custom widgets follow APG | N/A (no custom widgets; `details`, `fieldset`/radio, `select` are native) | |
| A11Y-41 | Consistent help | N/A (single page, no help mechanism) | |
| A11Y-42 | Target size | PASS | Browser, measured: Translate 115×44, Copy 170×44, selects 456×44, text 928×258, Glossary summary 928×44, skip link 191×52; radios 24×24 but their `<label>` rows are 44 px tall and clickable, so the target is the row. Footer links are inline text (exempt) |
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

- **Screen reader (A11Y-34):** listen once to the `role="status"` / `role="alert"` regions with a screen reader. Not done; needs a person with a screen reader.
- **A11Y-20 error branch:** the focus return on an engine error is read in source only. Exercise it once with the engine stopped or a failing request.
- **A11Y-24:** a true browser zoom to 200 % has not been run; the 640 px viewport is the stand-in.
- **Rows resting on source and token colours:** A11Y-21 and A11Y-22 use measured token values; the rendered colours match the tokens for body text and the focus ring.
- **axe-core:** 0 violations in light and dark. Four empty textareas (`#text`, `#glossary`, `#hard`, `#soft`) are "incomplete" for `color-contrast` (background obscured), with no text to measure.

# Accessibility acceptance criteria

Source: WCAG 2.2 (https://www.w3.org/TR/WCAG22/), Level A + AA. `BP` = best practice from WAI-ARIA APG / WAI tutorials or a WCAG AAA item; BP rows are recorded but never block acceptance.

Each entry: **ID · title — WCAG SC (level) · Method**, then a measurable *Pass when*.
Methods: `AUTO` (static source check, `a11y_check.py lint` covers the ones marked ✓lint), `BROWSER` (needs rendering), `MANUAL` (reasoned check with written evidence).

Large text = ≥ 24 CSS px regular, or ≥ 18.66 CSS px (14 pt) bold.

## Contents
A. Document & structure (01–08) · B. Text alternatives & media (09–12) · C. Keyboard & focus (13–20) · D. Color, contrast & visual (21–29) · E. Forms & input (30–37) · F. Names, links & widgets (38–41) · G. Pointer & gestures (42–44) · H. Motion & time (45–48) · I. Multi-page consistency (49–51)

---

## A. Document & structure

**A11Y-01 · Page language** — 3.1.1 (A) · AUTO ✓lint
Pass when: `<html lang="…">` is present with a valid BCP 47 tag matching the page's primary language.

**A11Y-02 · Language of parts** — 3.1.2 (AA) · MANUAL
Pass when: every passage (sentence or longer, or a standalone phrase) in a different language has its own `lang` attribute.

**A11Y-03 · Page title** — 2.4.2 (A) · AUTO ✓lint + MANUAL
Pass when: exactly one non-empty `<title>`, unique within the site, describing the page (pattern: "Page – Site"). SPAs update `document.title` on route change.

**A11Y-04 · Landmarks** — 1.3.1 (A), 2.4.1 (A) · AUTO ✓lint
Pass when: exactly one `<main>`; site header/nav/footer use `<header>`, `<nav>`, `<footer>`; multiple `<nav>` elements each have a distinct accessible name (`aria-label`/`aria-labelledby`); all visible content is inside a landmark (BP).

**A11Y-05 · Headings** — 1.3.1 (A), 2.4.6 (AA) · AUTO ✓lint + MANUAL
Pass when: anything that looks like a heading is an `<h1>`–`<h6>` (and nothing that isn't a heading is); headings describe their section. BP: exactly one `<h1>`, no skipped levels going down (h2 → h4).

**A11Y-06 · Semantic structure** — 1.3.1 (A) · AUTO + MANUAL
Pass when: lists use `<ul>/<ol>/<li>`/`<dl>`; data tables use `<table>` with `<th>` (+ `scope` or `headers` for complex tables) and a `<caption>` or accessible name; no `<table>` used for layout; emphasis conveyed visually is also conveyed by `<strong>/<em>` where it carries meaning.

**A11Y-07 · Meaningful sequence & sensory cues** — 1.3.2 (A), 1.3.3 (A) · MANUAL
Pass when: DOM order matches the visual reading order (CSS `order`, absolute positioning, `flex-direction: row-reverse` do not reorder meaning); instructions never rely only on shape, position, size or sound ("click the round button on the right" alone fails).

**A11Y-08 · Valid ARIA & IDs** — 4.1.2 (A), 1.3.1 (A) · AUTO ✓lint
Pass when: `id`s are unique; every `aria-labelledby`/`aria-describedby`/`aria-controls`/`for` reference resolves; only valid roles and `aria-*` attributes are used, with required owned elements/states (e.g. `role="tab"` inside `role="tablist"` with `aria-selected`); no `role` overrides a native element's semantics without need (first rule of ARIA); no `aria-hidden="true"` on a focusable element or its ancestor.

## B. Text alternatives & media

**A11Y-09 · Images** — 1.1.1 (A) · AUTO ✓lint + MANUAL
Pass when: every `<img>` has an `alt`. Informative image → alt conveys the same information/function (not the filename, not "image of"). Decorative image → `alt=""` (or CSS background). Linked/button image → alt describes the destination/action. Complex image (chart, diagram) → short alt + adjacent long description or data table. `<input type="image">` and `<area>` have alt.

**A11Y-10 · SVG & icons** — 1.1.1 (A), 4.1.2 (A) · AUTO ✓lint
Pass when: inline `<svg>` that is informative has `role="img"` and an accessible name (`<title>` or `aria-label`); decorative SVG/icon fonts have `aria-hidden="true"` (and `focusable="false"` for SVG). Icon-only controls get their name on the control (see A11Y-38).

**A11Y-11 · Prerecorded media alternatives** — 1.2.1 (A), 1.2.2 (A), 1.2.3 (A), 1.2.5 (AA) · MANUAL
Pass when: audio-only has a transcript; video-only has a transcript or audio track; video with audio has synchronized captions (`<track kind="captions">` or burned-in, accurate) **and** audio description (or a text alternative covering the visual-only information). If caption/description content isn't available → `BLOCKED`.

**A11Y-12 · Live media** — 1.2.4 (AA) · MANUAL
Pass when: live audio in synchronized media has real-time captions. N/A if no live streams.

## C. Keyboard & focus

**A11Y-13 · Keyboard operable** — 2.1.1 (A) · AUTO ✓lint + MANUAL
Pass when: every action available by mouse is available by keyboard alone. No `click` handler on non-focusable elements (`div`, `span`, `li`, `img`) unless it also has an appropriate `role`, `tabindex="0"` and Enter/Space handling (prefer replacing it with `<button>`). `<a>` used for actions → `<button>`; `<a>` without `href` is not focusable.

**A11Y-14 · No keyboard trap** — 2.1.2 (A) · BROWSER/MANUAL
Pass when: focus can always leave any component with Tab/Shift+Tab or Esc (embedded editors, iframes, maps, modals once closed).

**A11Y-15 · Character key shortcuts** — 2.1.4 (A) · MANUAL
Pass when: any single-printable-key shortcut can be turned off or remapped, or is only active when its component has focus.

**A11Y-16 · Focus order** — 2.4.3 (A) · AUTO ✓lint + MANUAL
Pass when: no `tabindex` > 0; Tab order follows reading order; hidden content (closed menus, off-canvas drawers, collapsed panels) is not focusable (`hidden`, `display:none`, or `inert`).

**A11Y-17 · Visible focus** — 2.4.7 (AA), 1.4.11 (AA) · AUTO ✓lint + BROWSER
Pass when: every focusable element shows a visible focus indicator; any `outline: none/0` is paired with a `:focus-visible` replacement; indicator contrast ≥ 3:1 against adjacent colors. BP (2.4.13 AAA): indicator ≥ 2 CSS px solid outline around the element.

**A11Y-18 · Focus not obscured** — 2.4.11 (AA) · BROWSER
Pass when: a focused element is never entirely hidden by author content (sticky headers/footers, cookie banners, chat widgets). Use `scroll-padding-top`/`scroll-padding-bottom` equal to sticky bar heights.

**A11Y-19 · Bypass blocks** — 2.4.1 (A) · AUTO ✓lint
Pass when: a "Skip to main content" link is the first focusable element, visible on focus, targeting `<main>` (landmarks from A11Y-04 alone satisfy A, the skip link is required here as the project standard).

**A11Y-20 · Dialogs, menus & disclosure focus management** — 2.4.3 (A), 2.1.2 (A), APG · BROWSER/MANUAL
Pass when (modal dialog): opening moves focus into the dialog; Tab cycles within it; Esc closes it; closing returns focus to the trigger; background is inert (`<dialog>.showModal()` does all of this natively). Menus/disclosures: trigger has `aria-expanded` that reflects state; Esc closes and returns focus to trigger.

## D. Color, contrast & visual

**A11Y-21 · Text contrast** — 1.4.3 (AA) · AUTO (`contrast`) + BROWSER
Pass when: normal text ≥ 4.5:1, large text ≥ 3:1, against its actual background, in every state (default, hover, focus, visited, disabled-excluded) and every theme (light/dark). Text over images/gradients measured at the worst point. Placeholder text counts. Exempt: disabled controls, pure decoration, logos.

**A11Y-22 · Non-text contrast** — 1.4.11 (AA) · AUTO (`contrast`) + BROWSER
Pass when: boundaries/states of UI components needed to identify them (input borders, checkbox outlines, toggle states, focus rings) and graphical objects needed to understand content (chart lines, icons without text) are ≥ 3:1 against adjacent colors.

**A11Y-23 · Use of color** — 1.4.1 (A) · MANUAL
Pass when: color is never the only way to convey information. Errors have icon/text, chart series have labels/patterns, required fields have text/asterisk. Links within body text are underlined (or, if not, ≥ 3:1 against surrounding text and get a non-color cue on hover and focus).

**A11Y-24 · Zoom & resize text** — 1.4.4 (AA) · AUTO ✓lint + BROWSER
Pass when: viewport meta does not contain `user-scalable=no` or `maximum-scale` < 2 (prefer none); at 200% browser zoom no content or function is lost or clipped. Font sizes in `rem`/`em`.

**A11Y-25 · Reflow** — 1.4.10 (AA) · BROWSER
Pass when: at 320 CSS px viewport width (= 1280 px at 400%) content needs no horizontal scrolling and loses nothing. Exempt: content needing 2-D layout (data tables, maps, code), which may scroll in its own container.

**A11Y-26 · Text spacing** — 1.4.12 (AA) · BROWSER
Pass when: overriding line-height 1.5×, paragraph spacing 2×, letter-spacing 0.12em, word-spacing 0.16em causes no clipping or overlap (avoid fixed heights on text containers).

**A11Y-27 · Images of text** — 1.4.5 (AA) · MANUAL
Pass when: text is real text, not an image, except logos or where the specific presentation is essential.

**A11Y-28 · Orientation** — 1.3.4 (AA) · AUTO + BROWSER
Pass when: no lock to portrait or landscape (no CSS/JS that blocks content in one orientation) unless essential.

**A11Y-29 · Content on hover or focus** — 1.4.13 (AA) · BROWSER/MANUAL
Pass when: tooltips/popovers that appear on hover or focus are dismissible with Esc without moving pointer/focus, stay open while the pointer moves onto them, and persist until dismissed or no longer relevant. Also triggerable by keyboard focus.

## E. Forms & input

**A11Y-30 · Labels** — 1.3.1 (A), 3.3.2 (A), 4.1.2 (A) · AUTO ✓lint
Pass when: every `<input>` (except hidden/submit/button/image/reset), `<select>`, `<textarea>` has a programmatic label (`<label for>`, wrapping `<label>`, or `aria-labelledby`), which is also visible. `placeholder` is never the only label. Related controls (radio groups, checkbox groups, address blocks) are grouped in `<fieldset>` + `<legend>` or `role="group"` with a name.

**A11Y-31 · Input purpose** — 1.3.5 (AA) · AUTO ✓lint
Pass when: fields collecting info about the user have the correct `autocomplete` token (`name`, `given-name`, `email`, `tel`, `street-address`, `postal-code`, `country`, `username`, `current-password`, `new-password`, `one-time-code`, `cc-number`, `bday`, …).

**A11Y-32 · Instructions & required fields** — 3.3.2 (A) · MANUAL
Pass when: required fields are indicated in text (not color alone) and with `required` or `aria-required="true"`; format constraints (e.g. date format, password rules) are stated before input, linked via `aria-describedby`.

**A11Y-33 · Error identification & suggestion** — 3.3.1 (A), 3.3.3 (AA) · MANUAL/BROWSER
Pass when: on error, the field is identified and the error described in text; message is programmatically associated (`aria-describedby`), field gets `aria-invalid="true"`; the message suggests a fix when one is known. On submit with errors, focus moves to the first invalid field or an error summary linking to fields.

**A11Y-34 · Status messages** — 4.1.3 (AA) · AUTO + MANUAL
Pass when: results, confirmations, errors, loading/progress and "added to cart" messages that appear without a focus change are announced via `role="status"`, `role="alert"` or `aria-live`, with the live region present in the DOM before content is injected.

**A11Y-35 · Predictable on focus/input** — 3.2.1 (A), 3.2.2 (A) · MANUAL
Pass when: focusing an element or changing a value never automatically submits, navigates, opens a new window, or moves focus, unless the user was told beforehand. `<select onchange>` navigation → add an explicit Go button.

**A11Y-36 · Error prevention (legal/financial/data)** — 3.3.4 (AA) · MANUAL
Pass when: submissions that cause legal commitments, financial transactions, or modify/delete user data are reversible, checked for errors with a chance to correct, or confirmed in a review step.

**A11Y-37 · Redundant entry & accessible authentication** — 3.3.7 (A), 3.3.8 (AA) · AUTO ✓lint + MANUAL
Pass when: information already entered in the same process is auto-filled or selectable (e.g. "billing same as shipping"); login does not require a cognitive function test (memorizing, transcribing, puzzles) without an alternative; password and OTP fields allow paste and password managers (no `onpaste` blocking, correct `autocomplete`). Object-recognition CAPTCHAs are allowed at AA.

## F. Names, links & widgets

**A11Y-38 · Accessible names** — 4.1.2 (A), 2.5.3 (A) · AUTO ✓lint
Pass when: every link, button, form control, and custom widget has a non-empty accessible name. Icon-only buttons use `aria-label` or visually hidden text. Label in name: when a control has visible text, its accessible name contains that text, ideally starting with it (visible "Search" → name "Search", not "Find").

**A11Y-39 · Link purpose** — 2.4.4 (A) · AUTO ✓lint + MANUAL
Pass when: link purpose is clear from the link text or its programmatic context (sentence, list item, table cell, heading). Bare "click here", "read more", "more", "here" fail unless context disambiguates, BP: avoid them and use unique text. Links opening a new window/download say so (text or icon with name).

**A11Y-40 · Custom widgets follow APG** — 4.1.2 (A), APG · MANUAL
Pass when: every non-native widget (tabs, accordion, combobox, menu button, listbox, slider, carousel, tree, grid) implements the matching WAI-ARIA APG pattern: correct roles, states (`aria-expanded`, `aria-selected`, `aria-checked`, `aria-pressed`, `aria-current`), and keyboard model. States update when they change. If a native element exists (`<details>`, `<select>`, `<input type="range">`, `<dialog>`), prefer it.

**A11Y-41 · Consistent help** — 3.2.6 (A) · MANUAL
Pass when: help mechanisms (contact info, chat, FAQ link) repeated across pages appear in the same relative order.

## G. Pointer & gestures

**A11Y-42 · Target size** — 2.5.8 (AA) · BROWSER/AUTO
Pass when: pointer targets are ≥ 24×24 CSS px, or a 24 px-diameter circle centered on each smaller target doesn't intersect another target or circle. Exempt: inline links in text, native unstyled controls, essential presentation. BP (2.5.5 AAA): ≥ 44×44 for primary touch targets.

**A11Y-43 · Gestures & dragging** — 2.5.1 (A), 2.5.7 (AA) · MANUAL
Pass when: multipoint or path-based gestures (pinch, swipe) have a single-pointer alternative; any drag operation (sortable lists, sliders, maps, kanban) has a click/tap or button alternative.

**A11Y-44 · Pointer cancellation** — 2.5.2 (A) · MANUAL
Pass when: actions fire on the up-event (`click`), not `mousedown`/`touchstart`, or can be aborted/undone.

## H. Motion & time

**A11Y-45 · Pause, stop, hide** — 2.2.2 (A) · MANUAL
Pass when: auto-moving, scrolling, blinking content that starts automatically and lasts > 5 s (carousels, marquees, animations, video backgrounds), and auto-updating content, has a visible pause/stop/hide control.

**A11Y-46 · Flashes** — 2.3.1 (A) · MANUAL
Pass when: nothing flashes more than 3 times per second.

**A11Y-47 · Reduced motion** — BP (2.3.3 AAA) · AUTO ✓lint
Pass when: non-essential animations/transitions/parallax are disabled or reduced under `@media (prefers-reduced-motion: reduce)`.

**A11Y-48 · Timing & audio control** — 2.2.1 (A), 1.4.2 (A) · MANUAL
Pass when: time limits can be turned off, adjusted (≥ 10×), or extended with a warning and ≥ 20 s to respond (session timeouts too); audio that autoplays > 3 s has pause/stop or independent volume control (BP: no autoplay with sound).

## I. Multi-page consistency (N/A for single-page deliverables)

**A11Y-49 · Consistent navigation & identification** — 3.2.3 (AA), 3.2.4 (AA) · MANUAL
Pass when: repeated navigation appears in the same relative order on every page; components with the same function have the same label/icon everywhere.

**A11Y-50 · Multiple ways** — 2.4.5 (AA) · MANUAL
Pass when: a page in a set can be reached by at least two of: navigation menu, search, sitemap, table of contents, related links. Exempt: steps of a process.

**A11Y-51 · Route changes in SPAs** — 2.4.2 (A), 4.1.3 (AA), BP · MANUAL
Pass when: client-side navigation updates `document.title`, moves focus to the new view's `<h1>` or main region (or announces the change via a live region), and preserves back-button behavior.

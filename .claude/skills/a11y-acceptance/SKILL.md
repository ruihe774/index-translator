---
name: a11y-acceptance
description: Accessibility acceptance gate (WCAG 2.2 AA, WAI-ARIA APG) for this repository. Load BEFORE changing anything in `public/` (HTML, CSS, custom elements, dialogs, controls, colours, layout), even when the request never mentions accessibility. A UI change is not done until the affected criteria are verified and `A11Y-ACCEPTANCE.md` is updated.
---

# a11y-acceptance

Accessibility is an acceptance gate. `A11Y-ACCEPTANCE.md` (repo root) is the record: one row per criterion
`A11Y-01…51`, status `PASS`, `FAIL`, `N/A (reason)`, `BLOCKED (need)` or `UNVERIFIED (why)`, with evidence
(file:line, measured ratio, test name). `references/criteria.md` defines each criterion's "Pass when"; read the
rows your change can affect, not the whole file. CLAUDE.md ("Notes for changes") has the project rules.

Baseline: WCAG 2.2 Level A + AA. `BP` rows (best practice, some AAA) are recorded and never block. Out of scope:
WCAG 3, AAA, 4.1.1. "Hard to do" is never N/A; N/A means the triggering content does not exist.

## Workflow

1. **Scope.** Pick the criteria the change can touch. Anything not yours to invent (alt text for a picture you
   cannot see, a brand colour that fails contrast) is `BLOCKED`: say what you need, do not guess.
2. **Build.** Native elements first; ARIA only with no native option, following the APG pattern exactly. Choose
   colours by measured contrast (`python3 .claude/skills/a11y-acceptance/scripts/a11y_check.py contrast …`),
   never `outline: none` without a `:focus-visible` replacement, reduced-motion guard on animation.
3. **Verify.**
   - `bun run e2e` must stay green, `e2e/a11y.spec.ts` in particular: axe (WCAG 2.0 to 2.2 A+AA tags) in light
     and dark, 320 px reflow, text spacing, Tab order, focus outline, target size. New UI gets new tests there
     (axe in both schemes, idle and in each new state; 320 px; targets; keyboard and focus return), not only a
     manual look. `bun run lint:css` too.
   - `python3 .claude/skills/a11y-acceptance/scripts/a11y_check.py lint public/index.html` (static checks, stdlib
     only). It does not see markup built in script (dialogs, the read-from column), so those need the e2e tests.
   - `MANUAL` criteria (reading order, names that say something, keyboard flow): do it, write one line of
     evidence. Never PASS on assumption: no browser or no screen reader run means `UNVERIFIED`.
4. **Record.** Update the affected rows and add a dated pass entry to the header (scope, rows re-checked, tools
   run, what was **not** done, such as a screen reader or Firefox/Safari). Fix the `Summary` counts. Rows
   must be re-checkable without trusting your memory.
5. **Report.** Give the count by status and list every non-PASS row. Fix every new FAIL first; the one known
   FAIL is A11Y-13 (click-to-sync has no keyboard route). Do not widen it.

Per CLAUDE.md, if a change introduces lint errors or warnings (`lint:ts`, `lint:es`, `lint:css`), tell the user
which rules failed, even if fixed.

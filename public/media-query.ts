/** Where both panels fit side by side: the page's one width breakpoint, written as the stylesheets write it
 * (`scripts/lint_css.ts` checks that every width in `public/` is one of its list). */
export const TWO_COLUMNS = "(width >= 54rem)";

export function prefersReducedMotion(): boolean {
  try {
    return matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

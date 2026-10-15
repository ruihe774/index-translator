// A box that scrolls can be scrolled by keyboard only when it is focusable (WCAG 2.1.1). So `box`
// is a focusable, named group while its content is larger than it, and an ordinary element
// otherwise: a box that fits adds no tab stop. `watchContent` also looks at what changes inside the
// box (streamed text, a rebuilt view); a size change of the box itself is always looked at.

const MARKED = ["tabindex", "role", "aria-label"] as const;

export function focusableWhenScrolling(box: HTMLElement, label: string, watchContent = false) {
  let frame = 0;
  const check = () => {
    frame = 0;
    const scrolls = box.scrollWidth > box.clientWidth || box.scrollHeight > box.clientHeight;
    if (scrolls === box.hasAttribute("tabindex")) {
      return;
    }
    if (scrolls) {
      box.tabIndex = 0;
      box.setAttribute("role", "group");
      box.setAttribute("aria-label", label);
    } else {
      for (const name of MARKED) {
        box.removeAttribute(name);
      }
    }
  };
  const later = () => {
    frame ||= requestAnimationFrame(check);
  };
  new ResizeObserver(later).observe(box);
  if (watchContent) {
    new MutationObserver(later).observe(box, { childList: true, subtree: true, characterData: true });
  }
}

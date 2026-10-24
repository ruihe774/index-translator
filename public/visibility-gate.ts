import { prefersReducedMotion } from "./media-query.ts";

if (!prefersReducedMotion()) {
  document.body.style.transition = "opacity 100ms ease-out";
}
document.body.style.opacity = "1";

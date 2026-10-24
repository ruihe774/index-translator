import { prefersReducedMotion } from "./media-query.ts";

// We only have one stylesheet. If we add more, change here
const link: HTMLLinkElement = document.querySelector('link[rel="stylesheet"]')!;
const showPage = () => {
  if (!prefersReducedMotion()) {
    document.body.style.transition = "opacity 100ms ease-out";
  }
  document.body.style.opacity = "1";
};
link.addEventListener("load", showPage);
if (link.sheet) {
  showPage();
}

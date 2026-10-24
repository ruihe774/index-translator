import { prefersReducedMotion } from "./media-query.ts";

const showPage = () => {
  if (!prefersReducedMotion()) {
    document.body.style.transition = "opacity 100ms ease-out";
  }
  document.body.style.opacity = "1";
};

if (document.readyState === "loading") {
  document.addEventListener("readystatechange", showPage, { once: true });
} else {
  showPage();
}

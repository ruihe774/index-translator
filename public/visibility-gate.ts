import { prefersReducedMotion } from "./media-query.ts";

const showPage = () => {
  const div = document.createElement("div");
  document.body.append(div);
  div.style.all = "initial";
  div.style.font = "-apple-system-body";
  const dynamicTypeFontSize = parseFloat(getComputedStyle(div).fontSize);
  const dynamicTypeFontSizeClamped = Number.isNaN(dynamicTypeFontSize)
    ? 16 // I don't think this path is actually reachable.
    : Math.max(10, Math.min(20, dynamicTypeFontSize)); // Our UI layout cannot support too small or large font size.
  div.remove();
  document.documentElement.style.setProperty("--dynamic-type-font-size", `${dynamicTypeFontSizeClamped}px`);

  if (!prefersReducedMotion()) {
    document.body.style.transition = "opacity 0.1s ease-out";
  }
  document.body.style.opacity = "1";
};

if (document.readyState === "loading") {
  document.addEventListener("readystatechange", showPage, { once: true });
} else {
  showPage();
}

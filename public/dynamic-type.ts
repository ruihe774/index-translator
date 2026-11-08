/** Sets `--dynamic-type-font-size` from the system's text size (`-apple-system-body`; e2e mocks this module). */
export function applyDynamicType() {
  const div = document.createElement("div");
  document.body.append(div);
  div.style.all = "initial";
  div.style.font = "-apple-system-body";
  const dynamicTypeFontSize = parseFloat(getComputedStyle(div).fontSize);
  const dynamicTypeFontSizeClamped = Number.isNaN(dynamicTypeFontSize)
    ? 16 // I don't think this path is actually reachable.
    : Math.max(10, Math.min(20, dynamicTypeFontSize)); // Our UI layout cannot support too small or large font size.
  document.documentElement.style.setProperty("--dynamic-type-font-size", `${dynamicTypeFontSizeClamped}px`);
  div.remove();
}

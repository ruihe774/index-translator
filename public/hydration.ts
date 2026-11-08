import { applyDynamicType } from "./dynamic-type.ts";
import { prefersReducedMotion } from "./media-query.ts";
import { isLaunchedFromSplash, solvent } from "./solvent.ts";

const stylesheet = document.getElementById("stylesheet");

if (isLaunchedFromSplash && solvent.error) {
  stylesheet!.remove();
  const status = document.getElementById("status")!;
  status.textContent = solvent.error.message;
  status.insertAdjacentHTML("afterbegin", "<strong>Network error: </strong>");
  throw solvent.error;
} else {
  applyDynamicType();

  if (stylesheet) {
    document.body.style.opacity = "0";
    const p = new Promise((resolve) => {
      stylesheet.addEventListener("load", resolve);
      stylesheet.addEventListener("error", resolve);
    });
    document.head.append(stylesheet);
    await p;
  }

  if (document.body.style.opacity) {
    if (!prefersReducedMotion()) {
      document.body.animate([{ opacity: "0" }, { opacity: "1" }], { duration: 100, easing: "ease-out" });
    }
    document.body.style.opacity = "";
  }

  if (isLaunchedFromSplash) {
    document.body.innerHTML = solvent.html!;
    delete document.body.dataset.splash;
  }
}

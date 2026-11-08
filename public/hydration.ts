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

  // The splash and the page cross-fade: the old picture is taken before `update`, and nothing is drawn until the
  // stylesheet has loaded and the body is replaced. Without view transitions, or with reduced motion, the page
  // shows at once. While the pictures are shown, clicks reach no element (Chromium hit-tests the root whatever their
  // `pointer-events`); `data-hydrating` on the root marks that time.
  const update = async () => {
    if (stylesheet) {
      const p = new Promise((resolve) => {
        stylesheet.addEventListener("load", resolve);
        stylesheet.addEventListener("error", resolve);
      });
      document.head.append(stylesheet);
      await p;
    }

    const { body } = document;
    // The splash before 93e4756, still served by a stale service worker, writes app.html over itself and hides the
    // body; only this shows it again.
    body.style.opacity = "";
    if (isLaunchedFromSplash) {
      body.innerHTML = solvent.html!;
      delete body.dataset.splash;
    }
  };

  if ("startViewTransition" in document && !prefersReducedMotion()) {
    const { documentElement: root } = document;
    root.dataset.hydrating = "";
    const t = document.startViewTransition(update);
    void t.finished.finally(() => {
      delete root.dataset.hydrating;
    });
    t.ready
      .then(() => {
        for (const a of root.getAnimations({ subtree: true })) {
          if (a.effect instanceof KeyframeEffect && a.effect.pseudoElement?.startsWith("::view-transition")) {
            a.effect.updateTiming({ duration: 300, easing: "ease-out" });
          }
        }
      })
      // Skipped (e.g. the update took too long): the page is shown all the same.
      .catch(() => {});
    await t.updateCallbackDone;
  } else {
    await update();
  }
}

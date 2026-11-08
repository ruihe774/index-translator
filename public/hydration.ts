const { documentElement: root, body } = document;
const isLaunchedFromSplash = body.dataset.splash !== undefined;
const solventFetching = isLaunchedFromSplash
  ? fetch("/app.html")
      .then((r) => {
        if (r.ok) {
          return r.text();
        }
        throw new Error(r.statusText);
      })
      .then((t) => {
        const start = t.indexOf("<body>"),
          end = t.indexOf("</body>");
        if (start !== -1 && end !== -1) {
          return t.slice(start + 6, end);
        }
        throw new Error("Malformed HTML");
      })
      .then(
        (html) => ({ html, error: undefined }),
        (e) => ({ html: undefined, error: e as Error }),
      )
  : Promise.resolve({ html: undefined, error: new Error("Not launched from splash") });

const mediaQuery = import("./media-query.ts");
const elements = import("./elements/index.ts");

export const UNDOC = "/vendor/undoc";
export const PDFJS = "/vendor/pdfjs";
export const PDFINSPECTOR = "/vendor/pdf-inspector";
const undocVersion = fetch(`${UNDOC}/VERSION`, { cache: "no-cache" });
const pdfJsVersion = fetch(`${PDFJS}/VERSION`, { cache: "no-cache" });
const pdfInspectorVersion = fetch(`${PDFINSPECTOR}/VERSION`, { cache: "no-cache" });

const solvent = await solventFetching;

const stylesheet = document.getElementById("stylesheet");

if (isLaunchedFromSplash && solvent.error) {
  stylesheet!.remove();
  const status = document.getElementById("status")!;
  status.textContent = solvent.error.message;
  status.insertAdjacentHTML("afterbegin", "<strong>Network error: </strong>");
  throw solvent.error;
} else {
  if (root.dataset.e2e === undefined) {
    applyDynamicType();
  }

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
      await Promise.all([p, elements]);
    }

    // The splash before 93e4756, still served by a stale service worker, writes app.html over itself and hides the
    // body; only this shows it again.
    body.style.opacity = "";
    if (isLaunchedFromSplash) {
      body.innerHTML = solvent.html!;
      delete body.dataset.splash;
    }
  };

  // At this time ./media-query.ts should already be loaded,
  // so awaiting it should be immediate.
  if ("startViewTransition" in document && !(await mediaQuery).prefersReducedMotion.matches) {
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

function applyDynamicType() {
  const div = document.createElement("div");
  body.append(div);
  div.style.all = "initial";
  div.style.font = "-apple-system-body";
  const dynamicTypeFontSize = parseFloat(getComputedStyle(div).fontSize);
  const dynamicTypeFontSizeClamped = Number.isNaN(dynamicTypeFontSize)
    ? 16 // I don't think this path is actually reachable.
    : Math.max(10, Math.min(20, dynamicTypeFontSize)); // Our UI layout cannot support too small or large font size.
  root.style.setProperty("--dynamic-type-font-size", `${dynamicTypeFontSizeClamped}px`);
  div.remove();
}

export const docxInstalled = (await undocVersion).ok;
export const pdfInstalled = (await pdfJsVersion).ok && (await pdfInspectorVersion).ok;

// Equations in rendered Markdown, as MathML by Temml (public/vendor/temml, put there by
// scripts/fetch_web_libs.ts with its stylesheet and the Noto Sans Math font). The library is loaded
// the first time an equation is shown, never before. Until then, and when it is missing or cannot
// read an equation, the equation is shown as its TeX source. Temml builds the MathML with the DOM API
// (`render`), never from a string; `trust` stays off, so no TeX command makes a link, a picture or an
// attribute of its choosing.

const DIR = "/vendor/temml";
/** Imports Temml's stylesheet into its layer (style.css orders it after the page's components). */
const STYLESHEET = "/css/temml.css";

/** The part of Temml that is used (temml.d.ts of the package). */
interface Temml {
  render(
    expression: string,
    baseNode: Element,
    options: { displayMode: boolean; annotate: boolean; throwOnError: boolean },
  ): void;
}

let temml: Temml | undefined;
let state: "idle" | "loading" | "failed" = "idle";

/** Equations already built, by display mode and TeX; null for one Temml refused. The streamed tail is rebuilt every frame. */
const built = new Map<string, Element | null>();
const BUILT_LIMIT = 500;

/** Shown while Temml is loading, or for good when it is missing or refuses the TeX. */
const SOURCE = "math-source";
/** An equation shown as its source because Temml has not loaded yet: it is built once Temml has. */
const PENDING = "math-pending";

function build(lib: Temml, tex: string, display: boolean): Element | null {
  const key = `${display ? "D" : "I"}${tex}`;
  let math = built.get(key);
  if (math === undefined) {
    const box = document.createElement("span");
    try {
      // `annotate` keeps the TeX in the MathML (<annotation>), so a copied equation carries it.
      lib.render(tex, box, { displayMode: display, annotate: true, throwOnError: true });
      math = box.firstElementChild;
    } catch {
      // A ParseError, and also what Temml throws besides one (a trailing "^", a bad \char).
      math = null;
    }
    if (built.size >= BUILT_LIMIT) {
      built.clear();
    }
    built.set(key, math);
  }
  return math && (math.cloneNode(true) as Element);
}

function fill(box: HTMLElement, tex: string | undefined, display: boolean, source: string) {
  const math = temml && tex !== undefined && build(temml, tex, display);
  if (math) {
    box.replaceChildren(math);
    return;
  }
  const text = document.createElement("span");
  text.className = SOURCE;
  text.textContent = source;
  box.replaceChildren(text);
  if (!temml && tex !== undefined && state !== "failed") {
    box.classList.add(PENDING);
    box.dataset.tex = tex;
    box.dataset.display = String(display);
    load();
  }
}

/** Loads Temml and its stylesheet once, then builds every equation on the page that waited for it. */
function load() {
  if (state !== "idle") {
    return;
  }
  state = "loading";
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = STYLESHEET;
  const styled = new Promise((resolve) => {
    link.addEventListener("load", resolve, { once: true });
    link.addEventListener("error", resolve, { once: true });
  });
  document.head.append(link);
  void Promise.all([import(`${DIR}/temml.mjs`) as Promise<{ default: Temml }>, styled]).then(
    ([module]) => {
      temml = module.default;
      for (const box of document.querySelectorAll<HTMLElement>(`.${PENDING}`)) {
        box.classList.remove(PENDING);
        const { tex = "", display } = box.dataset;
        delete box.dataset.tex;
        delete box.dataset.display;
        fill(box, tex, display === "true", box.textContent);
      }
    },
    () => {
      // Not installed (scripts/fetch_web_libs.ts was not run): the source stays, and nothing asks again.
      state = "failed";
      link.remove();
      for (const box of document.querySelectorAll<HTMLElement>(`.${PENDING}`)) {
        box.classList.remove(PENDING);
      }
    },
  );
}

/**
 * An equation: `display` for one set apart (`$$…$$`), else inline. The element is a `.math` box
 * holding the MathML, or `source`, the equation as written, while it cannot be shown otherwise or
 * `tex` is undefined. `block` makes it a block of its own rather than a part of a paragraph.
 */
export function equation(tex: string | undefined, display: boolean, source: string, block = false): HTMLElement {
  const box = document.createElement(block ? "div" : "span");
  box.className = display ? "math math-display" : "math";
  fill(box, tex, display, source);
  return box;
}

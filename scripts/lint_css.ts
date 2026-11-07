// Checks public/style.css and public/css/*.css against the browsers in .browserslistrc (caniuse data via doiuse).
// Stylelint (recommended rules) runs in the same PostCSS pipeline.
// The doiuse CLI cannot read nested CSS, so this uses its PostCSS plugin instead.
// It also keeps the page's width breakpoints to one list (`BREAKPOINTS`), in `@media` here and in `matchMedia`
// in public/*.ts: a width is a range (`width < 54rem`, `width >= 54rem`), never `min-width` / `max-width`, so
// there is no `53.99rem` beside `54rem`.
// Usage: bun scripts/lint_css.ts [file.css ...]   (exit 1 if a feature is unsupported or a breakpoint unlisted)

import browserslist from "browserslist";
import doiuse from "doiuse";
import postcss from "postcss";
import stylelint from "stylelint";

const files = Bun.argv.slice(2);
if (files.length === 0) {
  files.push("public/style.css");
  const names = await Array.fromAsync(new Bun.Glob("*").scan({ cwd: "public/css", onlyFiles: true }));
  for (const name of names.sort()) {
    files.push(`public/css/${name}`);
  }
}

/** Every width a media query may name, with where and why. 54rem is `TWO_COLUMNS` in public/media-query.ts. */
const BREAKPOINTS: Record<string, string> = {
  "54rem": "one column or two: the page's breakpoint",
  "22rem": "phone.css: the language select and the Raw/Preview switch no longer fit on one row",
  "40rem": "pane-carousel.css: the switch's bar moves up beside the site header",
  "44rem": "standalone.css: an installed app in landscape takes two columns",
};

/** Problems with the widths in one media query list, `where` naming its place. */
function checkWidths(query: string, where: string): string[] {
  const found: string[] = [];
  if (/\b(min|max)-(width|height)\s*:/.test(query)) {
    found.push(`${where} \`${query}\`: write a width as a range, \`(width < X)\` or \`(width >= X)\``);
  }
  for (const [, value] of query.matchAll(/\(\s*width\s*[<>]=?\s*([^\s)]+)\s*\)/g)) {
    if (!Object.hasOwn(BREAKPOINTS, value!)) {
      found.push(`${where} \`${query}\`: ${value} is not in BREAKPOINTS (scripts/lint_css.ts)`);
    }
  }
  if (/\(\s*[\d.]+\w*\s*[<>]/.test(query)) {
    found.push(`${where} \`${query}\`: put \`width\` first in a range`);
  }
  return found;
}

const browsers = browserslist();
let problems = 0;
for (const file of files) {
  const css = await Bun.file(file).text();
  const result = await postcss([
    stylelint({ config: { extends: ["stylelint-config-recommended"] } }),
    doiuse({
      browsers,
      // Reported only as "partial support" for properties used in their basic, widely supported
      // form (visually hidden text, resizable textarea, overflow hidden).
      ignore: ["css-clip-path", "css-masks", "css-overflow", "css-resize"],
      onFeatureUsage: (info: { message: string }) => {
        problems++;
        console.error(info.message);
      },
    }),
  ]).process(css, { from: file });
  result.root.walkAtRules("media", (rule) => {
    for (const problem of checkWidths(rule.params, `${file}:${rule.source?.start?.line ?? 0}`)) {
      problems++;
      console.error(problem);
    }
  });
  for (const warning of result.warnings()) {
    problems++;
    console.error(`${file}:${warning.line}:${warning.column} ${warning.text}`);
  }
}
if (Bun.argv.length === 2) {
  for await (const name of new Bun.Glob("**/*.ts").scan({ cwd: "public", onlyFiles: true })) {
    if (name.startsWith("vendor/")) {
      continue;
    }
    const text = await Bun.file(`public/${name}`).text();
    for (const [, query] of text.matchAll(/(?:matchMedia\(|TWO_COLUMNS = )\s*"([^"]*)"/g)) {
      for (const problem of checkWidths(query!, `public/${name}`)) {
        problems++;
        console.error(problem);
      }
    }
  }
}
console.log(`${files.length} file(s): checked against ${browsers.length} browser versions, ${problems} problem(s)`);
process.exit(problems ? 1 : 0);

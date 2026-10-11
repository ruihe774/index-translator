// Checks public/style.css against the browsers in .browserslistrc (caniuse data via doiuse).
// The doiuse CLI cannot read nested CSS, so this uses its PostCSS plugin instead.
// Usage: bun scripts/lint_css.ts [file.css ...]   (exit 1 if a feature is unsupported)

import { readFile } from "node:fs/promises";
import browserslist from "browserslist";
import doiuse from "doiuse";
import postcss from "postcss";

const files = Bun.argv.slice(2);
if (files.length === 0) files.push("public/style.css");

const browsers = browserslist();
let problems = 0;
for (const file of files) {
  const css = await readFile(file, "utf8");
  await postcss([
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
}
console.log(`${files.join(", ")}: checked against ${browsers.length} browser versions, ${problems} problem(s)`);
process.exit(problems ? 1 : 0);

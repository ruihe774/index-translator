// Checks public/style.css and public/css/*.css against the browsers in .browserslistrc (caniuse data via doiuse).
// Stylelint (recommended rules) runs in the same PostCSS pipeline.
// The doiuse CLI cannot read nested CSS, so this uses its PostCSS plugin instead.
// Usage: bun scripts/lint_css.ts [file.css ...]   (exit 1 if a feature is unsupported)

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
  for (const warning of result.warnings()) {
    problems++;
    console.error(`${file}:${warning.line}:${warning.column} ${warning.text}`);
  }
}
console.log(`${files.length} file(s): checked against ${browsers.length} browser versions, ${problems} problem(s)`);
process.exit(problems ? 1 : 0);

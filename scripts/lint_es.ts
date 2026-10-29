// Checks what the browser receives from public/*.ts against the browsers in .browserslistrc, with ESLint:
// eslint-plugin-browser-compat (APIs, MDN data) and eslint-plugin-es-x (syntax and built-ins by ES edition).
// Bun's linter has neither, and ESLint would slow `bun lint` down, hence a separate command.
// The input is Bun.Transpiler's output (what static.ts serves), not the TypeScript: ESLint cannot parse
// types, and syntax Bun rewrites (`using`) or drops (import attributes) must be judged as shipped.
// Usage: bun scripts/lint_es.ts [file.ts ...]   (exit 1 if a rule reports)

import browserslist from "browserslist";
import { ESLint, type Linter } from "eslint";
import browserCompat from "eslint-plugin-browser-compat";
import esX from "eslint-plugin-es-x";

// The newest ES edition whose features are all Baseline widely available (30 months). Raise it as
// editions age in: ES2025's regexp modifiers, duplicate named groups and Set methods are not there yet.
// Edition-level only: browser-compat decides per API against the browserslist query.
const ES_EDITION = "2024";

const files = Bun.argv.slice(2);
if (files.length === 0) {
  const names = await Array.fromAsync(new Bun.Glob("**/*.ts").scan({ cwd: "public", onlyFiles: true }));
  for (const name of names.sort()) {
    if (!name.startsWith("vendor/") && !name.endsWith(".d.ts")) {
      files.push(`public/${name}`);
    }
  }
}

const config: Linter.Config[] = [
  browserCompat.configs.recommended,
  esX.configs[`flat/restrict-to-es${ES_EDITION}`],
  esX.configs[`flat/restrict-to-es${ES_EDITION}-intl-api`],
  {
    // Marking the sentence under the pointer (`sentence-hover.ts`) is a nicety, not a feature the page needs:
    // it is switched on only where both exist (`supported()` there), and nothing else depends on it. Both
    // became Baseline in 2025 and are not yet widely available. Take them out when they are.
    // `ClipboardItem` (`copyTranslation` in app.ts) is feature-detected and Copy falls back to text alone;
    // Firefox gained it in 127, after the oldest browser the query covers.
    settings: { polyfills: ["Highlight", "document.caretPositionFromPoint", "ClipboardItem"] },
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    rules: {
      // Bun turns `using` into helpers imported from "bun:wrap", and drops `with { type: "json" }`.
      "no-restricted-imports": ["error", { patterns: ["bun:*", "*.json"] }],
    },
  },
];

const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: config });
const transpiler = new Bun.Transpiler({ loader: "ts" });

let problems = 0;
for (const file of files) {
  const code = transpiler.transformSync(await Bun.file(file).text());
  const lines = code.split("\n");
  // A virtual .js path under the working directory: ESLint wants a name for its configuration, not a file.
  const [result] = await eslint.lintText(code, { filePath: file.replace(/\.ts$/, ".js") });
  for (const message of result?.messages ?? []) {
    problems++;
    const snippet = (lines[message.line - 1] ?? "").trim().slice(0, 100);
    console.error(`${file} (transpiled line ${message.line}) ${message.ruleId ?? "parse error"}: ${message.message}`);
    console.error(`    ${snippet}`);
  }
}
const browsers = browserslist();
console.log(`${files.length} file(s): checked against ${browsers.length} browser versions, ${problems} problem(s)`);
process.exit(problems ? 1 : 0);

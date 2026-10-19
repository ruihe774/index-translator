// Runs a wasm32-wasip1 binary (cargo test runner). Usage: node wasi-run.mjs file.wasm [args...]
import { WASI } from 'node:wasi';
import { readFile } from 'node:fs/promises';

const [file, ...args] = process.argv.slice(2);
const wasi = new WASI({
  version: 'preview1',
  args: [file, ...args],
  env: process.env,
  preopens: { '/': '/' },
  returnOnExit: true,
});
const { instance } = await WebAssembly.instantiate(await readFile(file), wasi.getImportObject());
process.exit(wasi.start(instance));

for (const f of ["simd","relaxed","threads","mem64","multimem","tail"]) {
  try { const {instance} = await WebAssembly.instantiate(await Bun.file(`${f}.wasm`).arrayBuffer()); console.log(f, "ok", (instance.exports.f as any)()); }
  catch (e) { console.log(f, "FAIL", String(e)); }
}

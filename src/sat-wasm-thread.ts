// A thread of sat.wasm's pool (src/sat-wasm.ts): instantiates the module on the shared memory and runs
// `worker(tid)`, which takes tasks until the engine sets QUIT; it blocks this thread's event loop meanwhile.

declare const self: Worker;

self.onmessage = (e: MessageEvent<{ module: WebAssembly.Module; memory: WebAssembly.Memory; tid: number }>) => {
  const { module, memory, tid } = e.data;
  const { exports } = new WebAssembly.Instance(module, { env: { memory } });
  (exports.worker as (tid: number) => void)(tid);
};

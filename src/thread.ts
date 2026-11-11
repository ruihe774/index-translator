// A worker thread of the engine: instantiates the module on the shared memory and runs `worker(tid)`,
// which takes tasks until the engine sets QUIT (it blocks this thread's event loop meanwhile).
declare const self: Worker;

self.onmessage = async (e: MessageEvent<{ module: WebAssembly.Module; memory: WebAssembly.Memory; tid: number }>) => {
  const { module, memory, tid } = e.data;
  const { exports } = await WebAssembly.instantiate(module, { env: { memory } });
  self.postMessage("ready");
  (exports.worker as (tid: number) => void)(tid);
};

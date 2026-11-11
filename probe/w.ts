self.onmessage = async (e: MessageEvent) => {
  const { mem, mod } = e.data;
  const inst = await WebAssembly.instantiate(mod, { env: { mem } });
  postMessage("ready");
  const r = (inst.exports.wait as any)();
  (inst.exports.add as any)(10);
  postMessage(r);
};

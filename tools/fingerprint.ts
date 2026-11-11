// Prints Bun.hash of the bytes before the first weight of model.onnx (HEADER_HASH in engine.ts).
import { MODEL } from "../test/paths";

const path = process.argv[2] ?? MODEL;
const bytes = new Uint8Array(await Bun.file(path).slice(0, 343532).arrayBuffer());
console.log("0x" + BigInt(Bun.hash(bytes)).toString(16) + "n");

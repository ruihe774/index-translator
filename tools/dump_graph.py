import collections, onnx
from paths import MODEL as PATH
from onnx import numpy_helper
m = onnx.load(PATH, load_external_data=False)
g = m.graph
print("opset", [(o.domain,o.version) for o in m.opset_import], "ir", m.ir_version, "producer", m.producer_name, m.producer_version)
print("inputs", [(i.name, i.type) for i in g.input])
print("outputs", [(o.name, o.type) for o in g.output])
print("ops", collections.Counter(n.op_type for n in g.node))
print("n initializers", len(g.initializer))
for t in g.initializer:
    print(t.name, onnx.TensorProto.DataType.Name(t.data_type), list(t.dims), "raw" if t.HasField("raw_data") else "", t.data_location)

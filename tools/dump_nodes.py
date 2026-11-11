import onnx
from paths import MODEL as PATH
from onnx import helper, numpy_helper
m = onnx.load(PATH)
for n in m.graph.node:
    attrs = {}
    for a in n.attribute:
        v = helper.get_attribute_value(a)
        if isinstance(v, onnx.TensorProto):
            arr = numpy_helper.to_array(v); v = arr.tolist() if arr.size < 10 else f"tensor{arr.shape}"
        attrs[a.name] = v
    print(n.op_type, n.name, list(n.input), "->", list(n.output), attrs)

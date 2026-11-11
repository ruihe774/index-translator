(module (func (export "f") (result f32) (f32x4.extract_lane 0 (f32x4.add (v128.const f32x4 1 2 3 4) (v128.const f32x4 1 1 1 1)))))

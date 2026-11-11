(module (memory (export "m") 1 10 shared) (func (export "f") (result i32) (i32.atomic.rmw.add (i32.const 0) (i32.const 5))))

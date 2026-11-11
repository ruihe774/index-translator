(module (import "env" "mem" (memory 1 10 shared))
  (func (export "add") (param i32) (drop (i32.atomic.rmw.add (i32.const 0) (local.get 0))))
  (func (export "wait") (result i32) (memory.atomic.wait32 (i32.const 4) (i32.const 0) (i64.const 2000000000)))
  (func (export "wake") (result i32) (i32.atomic.store (i32.const 4) (i32.const 1)) (memory.atomic.notify (i32.const 4) (i32.const 10))))

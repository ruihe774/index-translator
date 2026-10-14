/* tslint:disable */
/* eslint-disable */

export class OfficeDocument {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    format(): string;
    static fromBytes(data: Uint8Array): Promise<OfficeDocument>;
    metadata(): string;
    toJson(): string;
    toMarkdown(): string;
    toText(): string;
}

export function parse(data: Uint8Array): Promise<OfficeDocument>;

/**
 * The formats this package can parse, as JSON.
 *
 * Returns `[{"extension":"docx","name":"Word Document"}, ...]`.
 *
 * A consumer that decides which files to hand to this package otherwise keeps its own copy
 * of the extension list, and that copy goes stale the moment this package learns a new
 * format -- silently, because nothing compares the two. Asking the package removes the
 * second copy. The name is included so a consumer can label a file without inventing its
 * own wording for a format this package already names.
 */
export function supportedFormats(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_officedocument_free: (a: number, b: number) => void;
    readonly officedocument_format: (a: number) => [number, number];
    readonly officedocument_fromBytes: (a: number, b: number) => any;
    readonly officedocument_metadata: (a: number) => [number, number, number, number];
    readonly officedocument_toJson: (a: number) => [number, number, number, number];
    readonly officedocument_toMarkdown: (a: number) => [number, number, number, number];
    readonly officedocument_toText: (a: number) => [number, number, number, number];
    readonly parse: (a: number, b: number) => any;
    readonly supportedFormats: () => [number, number, number, number];
    readonly wasm_bindgen_b886f896fd34b232___convert__closures_____invoke___js_sys_7d3929aa405b9504___Function_fn_wasm_bindgen_b886f896fd34b232___JsValue_____wasm_bindgen_b886f896fd34b232___sys__Undefined___js_sys_7d3929aa405b9504___Function_fn_wasm_bindgen_b886f896fd34b232___JsValue_____wasm_bindgen_b886f896fd34b232___sys__Undefined_______true_: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen_b886f896fd34b232___convert__closures_____invoke___wasm_bindgen_b886f896fd34b232___JsValue__core_ed718c3d60ebd546___result__Result_____wasm_bindgen_b886f896fd34b232___JsError___true_: (a: number, b: number, c: any) => [number, number];
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;

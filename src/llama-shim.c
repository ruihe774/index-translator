// The libllama calls that pass or return structs by value, which bun:ffi cannot express, plus the
// log filter and the device list. Compiled by scripts/build_llama.ts into libllama-shim, against the
// llama.h of the libllama it has just built and puts next to it, so the struct layouts always match
// that library. After a change here: bun scripts/build_llama.ts --shim. Everything else is called
// directly from src/llama-ffi.ts.

#include <stdio.h>

#include "llama.h"

// The functions bun:ffi looks up by name; a Windows DLL exports only what is marked.
#if defined(_WIN32)
#    define SHIM_API __declspec(dllexport)
#else
#    define SHIM_API __attribute__((visibility("default")))
#endif

static enum ggml_log_level shim_log_level = GGML_LOG_LEVEL_INFO;

// Drops llama.cpp's per-tensor debug output; a continuation line keeps the level of the line it continues.
static void shim_log(enum ggml_log_level level, const char * text, void * user_data) {
    (void) user_data;
    if (level == GGML_LOG_LEVEL_CONT) {
        level = shim_log_level;
    } else {
        shim_log_level = level;
    }
    if (level != GGML_LOG_LEVEL_DEBUG) {
        fputs(text, stderr);
    }
}

// Once per process. `backend_dir` holds the libggml-* backends (Vulkan, CPU variants).
SHIM_API void shim_init(const char * backend_dir) {
    llama_log_set(shim_log, NULL);
    llama_backend_init();
    ggml_backend_load_all_from_path(backend_dir);
}

// The devices the loaded backends found. Returns how many, and writes them to `out` as
// "type name: description" lines, as far as `size` bytes go. A model is offloaded to the ones of
// type gpu and igpu; without one of type cpu nothing can run.
SHIM_API int32_t shim_devices(char * out, int32_t size) {
    static const char * const types[] = { "cpu", "gpu", "igpu", "accel", "meta" };
    int32_t count = (int32_t) ggml_backend_dev_count();
    int32_t used = 0;
    if (size > 0) {
        out[0] = '\0';
    }
    for (int32_t i = 0; i < count && used < size; i++) {
        ggml_backend_dev_t dev = ggml_backend_dev_get((size_t) i);
        enum ggml_backend_dev_type type = ggml_backend_dev_type(dev);
        const char * kind = (size_t) type < sizeof(types) / sizeof(types[0]) ? types[type] : "other";
        int n = snprintf(out + used, (size_t) (size - used), "%s %s: %s\n", kind, ggml_backend_dev_name(dev), ggml_backend_dev_description(dev));
        if (n > 0) {
            used += n;
        }
    }
    return count;
}

// A negative `n_gpu_layers` offloads every layer.
SHIM_API struct llama_model * shim_load_model(const char * path, int32_t n_gpu_layers) {
    struct llama_model_params params = llama_model_default_params();
    params.n_gpu_layers = n_gpu_layers;
    return llama_model_load_from_file(path, params);
}

// One sequence that may use the whole window. `n_threads` of 0 keeps the library default.
SHIM_API struct llama_context * shim_new_context(struct llama_model * model, uint32_t n_ctx, uint32_t n_batch, int32_t n_threads) {
    struct llama_context_params params = llama_context_default_params();
    params.n_ctx = n_ctx;
    params.n_batch = n_batch;
    params.n_seq_max = 1;
    if (n_threads > 0) {
        params.n_threads = n_threads;
        params.n_threads_batch = n_threads;
    }
    return llama_init_from_model(model, params);
}

// Appends `n` tokens to the sequence; logits are computed for the last one.
SHIM_API int32_t shim_decode(struct llama_context * ctx, llama_token * tokens, int32_t n) {
    return llama_decode(ctx, llama_batch_get_one(tokens, n));
}

// The libllama calls that pass or return structs by value, which bun:ffi cannot express, plus the
// log filter. Compiled at startup by bun:ffi's built-in C compiler against the vendored llama.h, so
// the struct layouts always match the library next to it. Everything else is called directly from
// src/llama-ffi.ts.

#include "llama.h"

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
void shim_init(const char * backend_dir) {
    llama_log_set(shim_log, NULL);
    llama_backend_init();
    ggml_backend_load_all_from_path(backend_dir);
}

// A negative `n_gpu_layers` offloads every layer.
struct llama_model * shim_load_model(const char * path, int32_t n_gpu_layers) {
    struct llama_model_params params = llama_model_default_params();
    params.n_gpu_layers = n_gpu_layers;
    return llama_model_load_from_file(path, params);
}

// One sequence that may use the whole window. `n_threads` of 0 keeps the library default.
struct llama_context * shim_new_context(struct llama_model * model, uint32_t n_ctx, uint32_t n_batch, int32_t n_threads) {
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
int32_t shim_decode(struct llama_context * ctx, llama_token * tokens, int32_t n) {
    return llama_decode(ctx, llama_batch_get_one(tokens, n));
}

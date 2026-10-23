// The libllama functions multi-token prediction needs that only llama.cpp's staging header
// (src/llama-ext.h) declares. That header is C++, so libllama exports them under C++-mangled names,
// which neither bun:ffi nor src/llama-shim.c can name; this file gives them C names. Compiled into
// libllama-shim with src/llama-shim.c by scripts/build_llama.ts. The header is staging API: after a
// llama.cpp pin change, check these signatures against it.

#include "llama-ext.h"

#if defined(_WIN32)
#    define SHIM_API __declspec(dllexport)
#else
#    define SHIM_API __attribute__((visibility("default")))
#endif

extern "C" {

// Whether the context outputs the hidden state its MTP head reads. `masked`: only for the tokens
// that have logits; otherwise for every token of the batch.
SHIM_API void shim_ext_set_embeddings_nextn(struct llama_context * ctx, bool value, bool masked) {
    llama_set_embeddings_nextn(ctx, value, masked);
}

// The rows of the last batch, one per token (unmasked) or per output (masked), n_embd floats each.
SHIM_API float * shim_ext_get_embeddings_nextn(struct llama_context * ctx) {
    return llama_get_embeddings_nextn(ctx);
}

// The row of batch entry `i`.
SHIM_API float * shim_ext_get_embeddings_nextn_ith(struct llama_context * ctx, int32_t i) {
    return llama_get_embeddings_nextn_ith(ctx, i);
}

}

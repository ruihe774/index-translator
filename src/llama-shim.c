// The libllama and libmtmd (image input) calls that pass or return structs, which bun:ffi cannot
// express, plus the log filter, the device list and multi-token prediction. Compiled by
// scripts/build_llama.ts into libllama-shim, with src/llama-shim-ext.cpp, against the headers of the
// libraries it has just built and puts next to it, so the struct layouts always match them. After a
// change here: bun scripts/build_llama.ts --shim. Everything else is called directly from src/llama-ffi.ts.

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "llama.h"
#include "mtmd.h"
#include "mtmd-helper.h"

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
    mtmd_helper_log_set(shim_log, NULL);
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

// Free and total memory in bytes, summed over the devices of type gpu and igpu, the ones a model is
// offloaded to. What the backend reports for a device, not what this process holds. Returns how many
// devices were counted; 0 leaves the outputs alone.
SHIM_API int32_t shim_gpu_memory(uint64_t * free_bytes, uint64_t * total_bytes) {
    int32_t counted = 0;
    uint64_t free_sum = 0;
    uint64_t total_sum = 0;
    for (size_t i = 0; i < ggml_backend_dev_count(); i++) {
        ggml_backend_dev_t dev = ggml_backend_dev_get(i);
        enum ggml_backend_dev_type type = ggml_backend_dev_type(dev);
        if (type != GGML_BACKEND_DEVICE_TYPE_GPU && type != GGML_BACKEND_DEVICE_TYPE_IGPU) {
            continue;
        }
        size_t device_free = 0;
        size_t device_total = 0;
        ggml_backend_dev_memory(dev, &device_free, &device_total);
        free_sum += device_free;
        total_sum += device_total;
        counted++;
    }
    if (counted > 0) {
        *free_bytes = free_sum;
        *total_bytes = total_sum;
    }
    return counted;
}

// A negative `n_gpu_layers` offloads every layer. `load_mtp` also loads the model's MTP layers,
// which are skipped otherwise.
SHIM_API struct llama_model * shim_load_model(const char * path, int32_t n_gpu_layers, bool load_mtp) {
    struct llama_model_params params = llama_model_default_params();
    params.n_gpu_layers = n_gpu_layers;
    params.load_mtp = load_mtp;
    return llama_model_load_from_file(path, params);
}

// Most tokens one multi-token prediction step drafts (below).
#define SHIM_MTP_MAX_DRAFT 8

// One sequence that may use the whole window. `n_threads` of 0 keeps the library default.
// `n_rs_seq`: how many of its last tokens a recurrent model can drop again (llama_memory_seq_rm),
// which costs one more copy of the recurrent state each; 0 without speculative decoding.
SHIM_API struct llama_context * shim_new_context(struct llama_model * model, uint32_t n_ctx, uint32_t n_batch, int32_t n_threads, uint32_t n_rs_seq) {
    struct llama_context_params params = llama_context_default_params();
    params.n_ctx = n_ctx;
    params.n_batch = n_batch;
    params.n_seq_max = 1;
    params.n_rs_seq = n_rs_seq;
    // Logits are only wanted for the last token of a decode, or for each token of an MTP
    // verification; libmtmd asks for none on an image. The default (n_batch) reserves
    // n_batch * n_vocab floats, about 0.4 GiB of GPU memory for a vocabulary of 248K. More than
    // this many outputs in one batch would abort in llama.cpp (an assertion), not fail.
    params.n_outputs_max = SHIM_MTP_MAX_DRAFT + 1;
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

// Appends `n` tokens at the positions from `pos` on. After an image the next position is not the
// number of tokens so far (an M-RoPE model counts an image by its larger side), so there
// llama_decode cannot work it out itself.
SHIM_API int32_t shim_decode_at(struct llama_context * ctx, const llama_token * tokens, int32_t n, llama_pos pos) {
    struct llama_batch batch = llama_batch_init(n, 0, 1);
    for (int32_t i = 0; i < n; i++) {
        batch.token[i] = tokens[i];
        batch.pos[i] = pos + i;
        batch.n_seq_id[i] = 1;
        batch.seq_id[i][0] = 0;
        batch.logits[i] = i == n - 1;
    }
    batch.n_tokens = n;
    int32_t status = llama_decode(ctx, batch);
    llama_batch_free(batch);
    return status;
}

// The model's image encoder and projector (its mmproj file). NULL when it cannot be loaded or does
// not take images.
SHIM_API mtmd_context * shim_mtmd_load(const char * path, const struct llama_model * model, bool use_gpu, int32_t n_threads) {
    struct mtmd_context_params params = mtmd_context_params_default();
    params.use_gpu = use_gpu;
    params.print_timings = false;
    // No warm-up run: the file is only loaded when the first image arrives, which then pays for it.
    params.warmup = false;
    if (n_threads > 0) {
        params.n_threads = n_threads;
    }
    mtmd_context * ctx = mtmd_init_from_file(path, model, params);
    if (ctx != NULL && !mtmd_support_vision(ctx)) {
        mtmd_free(ctx);
        return NULL;
    }
    return ctx;
}

// libmtmd's image decoder (vendor/stb/stb_image.h), which the library exports without a header.
extern unsigned char * stbi_load_from_memory(const unsigned char * buffer, int len, int * x, int * y, int * channels_in_file, int desired_channels);
extern void stbi_image_free(void * retval_from_stbi_load);

// Decodes an image file held in memory (PNG among others) for the encoder. NULL when it is not
// one. This is what mtmd_helper_bitmap_init_from_buf does, except that it drops the alpha channel,
// which turns dark text on a transparent background into nothing on black: here transparency
// becomes white.
SHIM_API mtmd_bitmap * shim_mtmd_bitmap(const unsigned char * data, size_t size) {
    int width = 0;
    int height = 0;
    int channels = 0;
    if (size > INT32_MAX) {
        return NULL;
    }
    unsigned char * rgba = stbi_load_from_memory(data, (int) size, &width, &height, &channels, 4);
    if (rgba == NULL) {
        return NULL;
    }
    // In place: pixel i's three bytes are written where pixels before it were already read.
    size_t pixels = (size_t) width * (size_t) height;
    for (size_t i = 0; i < pixels; i++) {
        unsigned alpha = rgba[i * 4 + 3];
        for (int c = 0; c < 3; c++) {
            rgba[i * 3 + c] = (unsigned char) ((rgba[i * 4 + c] * alpha + 255 * (255 - alpha) + 127) / 255);
        }
    }
    mtmd_bitmap * bitmap = mtmd_bitmap_init((uint32_t) width, (uint32_t) height, rgba);
    stbi_image_free(rgba);
    return bitmap;
}

// `head`, `body`, the image, `tail` as the chunks to evaluate in that order: text tokens, the image
// between the model's own image tokens, text tokens. Special tokens are parsed in `head` and `tail`
// (the template) but not in `body` (the user's text, where they are only text). NULL on failure;
// freed with mtmd_input_chunks_free.
SHIM_API mtmd_input_chunks * shim_mtmd_tokenize(const mtmd_context * ctx, const char * head, size_t head_size, const char * body, size_t body_size, const mtmd_bitmap * bitmap, const char * tail, size_t tail_size) {
    const struct mtmd_input_text head_text = { head, head_size, true, true };
    const struct mtmd_input_text body_text = { body, body_size, false, false };
    const struct mtmd_input_text tail_text = { tail, tail_size, false, true };
    const struct mtmd_input_part parts[] = { { &head_text, NULL }, { &body_text, NULL }, { NULL, bitmap }, { &tail_text, NULL } };
    const struct mtmd_input_part * const list[] = { &parts[0], &parts[1], &parts[2], &parts[3] };
    mtmd_input_chunks * chunks = mtmd_input_chunks_init();
    if (mtmd_tokenize_from_parts(ctx, chunks, list, 4, true) != 0) {
        mtmd_input_chunks_free(chunks);
        return NULL;
    }
    return chunks;
}

// Evaluates chunk `index` after what the context holds: text is decoded, an image is encoded and
// its embeddings are decoded. `pos` is the next position, read and advanced. Logits are computed
// after the last chunk.
SHIM_API int32_t shim_mtmd_eval_chunk(mtmd_context * ctx, struct llama_context * lctx, const mtmd_input_chunks * chunks, int32_t index, int32_t n_batch, llama_pos * pos) {
    const mtmd_input_chunk * chunk = mtmd_input_chunks_get(chunks, (size_t) index);
    bool last = (size_t) index + 1 == mtmd_input_chunks_size(chunks);
    return mtmd_helper_eval_chunk_single(ctx, lctx, chunk, *pos, 0, n_batch, last, pos);
}

// Multi-token prediction (MTP): the model's own MTP layer drafts the next tokens, and one decode of
// the target checks them all. Greedy, one sequence, one MTP layer (Qwen3.5); ported from
// common/speculative.cpp (draft-mtp) and the server's verification in tools/server/server-context.cpp.
// The MTP layer reads, for each token, the hidden state the target computed for the token before
// it; those come from the staging calls in src/llama-shim-ext.cpp.

// From src/llama-shim-ext.cpp.
void shim_ext_set_embeddings_nextn(struct llama_context * ctx, bool value, bool masked);
float * shim_ext_get_embeddings_nextn(struct llama_context * ctx);
float * shim_ext_get_embeddings_nextn_ith(struct llama_context * ctx, int32_t i);

struct shim_mtp {
    struct llama_context * tgt;
    // A context of type MTP on the same model: the MTP layer with its own KV cache.
    struct llama_context * dft;
    struct llama_batch_ext * batch;
    struct llama_sampler * greedy;
    int32_t n_embd;
    // The target's hidden state for the last token it has evaluated, which goes with the next token.
    float * pending;
    // The target's hidden states for the tokens of the last verification.
    float * rows;
};

SHIM_API void shim_mtp_free(struct shim_mtp * m);

// The MTP drafter for `tgt`, a context of `model` loaded with its MTP layers and created with
// n_rs_seq of at least the draft length. NULL when the model has no MTP layer or the context cannot
// be created. Freed with shim_mtp_free before `tgt`.
SHIM_API struct shim_mtp * shim_mtp_new(struct llama_model * model, struct llama_context * tgt, uint32_t n_ctx, uint32_t n_batch, int32_t n_threads) {
    if (llama_model_n_layer_nextn(model) < 1) {
        return NULL;
    }
    struct llama_context_params params = llama_context_default_params();
    params.ctx_type = LLAMA_CONTEXT_TYPE_MTP;
    params.n_ctx = n_ctx;
    params.n_batch = n_batch;
    params.n_seq_max = 1;
    // A draft has one output and catching up none: logits for a whole batch would reserve
    // n_batch * n_vocab floats (half a GiB on Vulkan) for nothing.
    params.n_outputs_max = 1;
    if (n_threads > 0) {
        params.n_threads = n_threads;
        params.n_threads_batch = n_threads;
    }
    struct llama_context * dft = llama_init_from_model(model, params);
    if (dft == NULL) {
        return NULL;
    }
    struct shim_mtp * m = calloc(1, sizeof(*m));
    if (m == NULL) {
        llama_free(dft);
        return NULL;
    }
    m->tgt = tgt;
    m->dft = dft;
    m->n_embd = llama_model_n_embd_out(model);
    m->pending = calloc((size_t) m->n_embd, sizeof(float));
    m->rows = calloc((size_t) (SHIM_MTP_MAX_DRAFT + 1) * (size_t) m->n_embd, sizeof(float));
    m->batch = llama_batch_ext_init(dft);
    m->greedy = llama_sampler_init_greedy();
    if (m->pending == NULL || m->rows == NULL || m->batch == NULL || m->greedy == NULL) {
        shim_mtp_free(m);
        return NULL;
    }
    // The target's state for every token of a batch, the MTP layer's only for the ones with logits.
    shim_ext_set_embeddings_nextn(tgt, true, false);
    shim_ext_set_embeddings_nextn(dft, true, true);
    return m;
}

SHIM_API void shim_mtp_free(struct shim_mtp * m) {
    if (m->batch != NULL) {
        llama_batch_ext_free(m->batch);
    }
    if (m->greedy != NULL) {
        llama_sampler_free(m->greedy);
    }
    llama_free(m->dft);
    free(m->pending);
    free(m->rows);
    free(m);
}

// Empties the MTP layer's cache, with the target's (llama_memory_clear), for a new prompt.
SHIM_API void shim_mtp_reset(struct shim_mtp * m) {
    llama_memory_clear(llama_get_memory(m->dft), true);
    memset(m->pending, 0, (size_t) m->n_embd * sizeof(float));
}

// Feeds the MTP layer the `n` tokens the target has just decoded at positions `pos` on, each with
// the target's state for the token before it. `rows`: also keep the target's states (at most
// SHIM_MTP_MAX_DRAFT + 1). Returns llama_process's status.
static int32_t mtp_catch_up(struct shim_mtp * m, const llama_token * tokens, int32_t n, llama_pos pos, bool rows) {
    const float * h = shim_ext_get_embeddings_nextn(m->tgt);
    if (h == NULL || n < 1) {
        return -1;
    }
    const size_t row = (size_t) m->n_embd;
    llama_batch_ext_clear(m->batch);
    for (int32_t i = 0; i < n; i++) {
        int32_t idx = llama_batch_ext_add_token(m->batch, 0, tokens[i]);
        llama_pos p = pos + i;
        struct llama_embd state = { i == 0 ? m->pending : h + (size_t) (i - 1) * row, 1, row };
        if (idx < 0 || !llama_batch_ext_set_pos(m->batch, idx, &p) || !llama_batch_ext_set_embd_state(m->batch, idx, state)) {
            return -1;
        }
    }
    int32_t status = llama_process(m->dft, LLAMA_PROCESS_TYPE_DECODE, m->batch);
    if (status != 0) {
        return status;
    }
    memcpy(m->pending, h + (size_t) (n - 1) * row, row * sizeof(float));
    if (rows) {
        memcpy(m->rows, h, (size_t) n * row * sizeof(float));
    }
    return 0;
}

// After the target decoded `n` prompt tokens at positions `pos` on (shim_decode, which counts them).
SHIM_API int32_t shim_mtp_catch_up(struct shim_mtp * m, const llama_token * tokens, int32_t n, llama_pos pos) {
    return mtp_catch_up(m, tokens, n, pos, false);
}

// One step after `last`, the token the target chose at position `pos` that is not decoded yet:
// drafts `n_draft` tokens (at most SHIM_MTP_MAX_DRAFT; 0 only decodes `last`), decodes `last` and
// the drafts with the target and keeps the drafts it would have chosen itself. Writes the target's
// choices to `out` (n_draft + 1 room): the token after `last`, then one more for each draft kept.
// Returns how many, or -1 on failure. The contexts end after `last` and the kept drafts, so the next
// step starts at `pos` + the count with `out`'s last token.
SHIM_API int32_t shim_mtp_step(struct shim_mtp * m, struct llama_sampler * sampler, llama_token last, llama_pos pos, int32_t n_draft, llama_token * out) {
    if (n_draft > SHIM_MTP_MAX_DRAFT) {
        n_draft = SHIM_MTP_MAX_DRAFT;
    }
    if (n_draft < 0) {
        n_draft = 0;
    }
    llama_memory_t mem_tgt = llama_get_memory(m->tgt);
    llama_memory_t mem_dft = llama_get_memory(m->dft);
    const size_t row = (size_t) m->n_embd;

    // `tokens`: `last`, then the drafts. Each draft decodes the token before it with the state the
    // MTP layer itself output for that one (the first: the target's).
    llama_token tokens[SHIM_MTP_MAX_DRAFT + 1];
    tokens[0] = last;
    const float * state = m->pending;
    for (int32_t i = 0; i < n_draft; i++) {
        llama_batch_ext_clear(m->batch);
        int32_t idx = llama_batch_ext_add_token(m->batch, 0, tokens[i]);
        llama_pos p = pos + i;
        struct llama_embd embd = { state, 1, row };
        if (idx < 0 || !llama_batch_ext_set_pos(m->batch, idx, &p) || !llama_batch_ext_set_output_logits(m->batch, idx, true) ||
            !llama_batch_ext_set_embd_state(m->batch, idx, embd)) {
            return -1;
        }
        if (llama_process(m->dft, LLAMA_PROCESS_TYPE_DECODE, m->batch) != 0) {
            return -1;
        }
        tokens[i + 1] = llama_sampler_sample(m->greedy, m->dft, idx);
        state = shim_ext_get_embeddings_nextn_ith(m->dft, idx);
        if (state == NULL) {
            return -1;
        }
    }
    // The drafts leave the MTP layer's cache: catching up after the verification writes it again.
    if (n_draft > 0 && !llama_memory_seq_rm(mem_dft, 0, pos, -1)) {
        return -1;
    }

    const int32_t n = n_draft + 1;
    struct llama_batch batch = llama_batch_init(n, 0, 1);
    for (int32_t i = 0; i < n; i++) {
        batch.token[i] = tokens[i];
        batch.pos[i] = pos + i;
        batch.n_seq_id[i] = 1;
        batch.seq_id[i][0] = 0;
        batch.logits[i] = true;
    }
    batch.n_tokens = n;
    int32_t status = llama_decode(m->tgt, batch);
    llama_batch_free(batch);
    if (status != 0 || mtp_catch_up(m, tokens, n, pos, true) != 0) {
        return -1;
    }

    // The target's choice after each token; a draft is kept while it is what the target chose.
    int32_t kept = 0;
    for (;;) {
        out[kept] = llama_sampler_sample(sampler, m->tgt, kept);
        if (kept == n_draft || out[kept] != tokens[kept + 1]) {
            break;
        }
        kept++;
    }
    memcpy(m->pending, m->rows + (size_t) kept * row, row * sizeof(float));
    // Drop the drafts after the kept ones; the recurrent layers can (n_rs_seq), the KV caches always.
    if (kept < n_draft) {
        if (!llama_memory_seq_rm(mem_tgt, 0, pos + kept + 1, -1) || !llama_memory_seq_rm(mem_dft, 0, pos + kept + 1, -1)) {
            return -1;
        }
    }
    return kept + 1;
}

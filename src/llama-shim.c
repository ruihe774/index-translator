// The libllama and libmtmd (image input) calls that pass or return structs, which bun:ffi cannot
// express, plus the log filter and the device list. Compiled by scripts/build_llama.ts into
// libllama-shim, against the headers of the libraries it has just built and puts next to it, so the
// struct layouts always match them. After a change here: bun scripts/build_llama.ts --shim. Everything else is called
// directly from src/llama-ffi.ts.

#include <stdint.h>
#include <stdio.h>

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

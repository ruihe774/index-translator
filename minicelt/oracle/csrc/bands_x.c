/* celt/bands.c with its static functions exposed as oracle_<name>.
   struct band_ctx / struct split_ctx are passed as void* (layout in oracle_bands_layout). */
#include "bands.c"
#include "layout.h"

const struct oracle_layout_entry oracle_bands_layout[] = {
   L_SIZE(struct band_ctx), L_OFF(struct band_ctx, encode), L_OFF(struct band_ctx, resynth),
   L_OFF(struct band_ctx, m), L_OFF(struct band_ctx, i), L_OFF(struct band_ctx, intensity),
   L_OFF(struct band_ctx, spread), L_OFF(struct band_ctx, tf_change), L_OFF(struct band_ctx, ec),
   L_OFF(struct band_ctx, remaining_bits), L_OFF(struct band_ctx, bandE), L_OFF(struct band_ctx, seed),
   L_OFF(struct band_ctx, arch), L_OFF(struct band_ctx, theta_round), L_OFF(struct band_ctx, disable_inv),
   L_OFF(struct band_ctx, avoid_split_noise),
   L_SIZE(struct split_ctx), L_OFF(struct split_ctx, inv), L_OFF(struct split_ctx, imid),
   L_OFF(struct split_ctx, iside), L_OFF(struct split_ctx, delta), L_OFF(struct split_ctx, itheta),
   L_OFF(struct split_ctx, qalloc),
   L_END
};

void oracle_compute_channel_weights(float Ex, float Ey, float w[2]) { compute_channel_weights(Ex, Ey, w); }

void oracle_intensity_stereo(const void *m, float *X, const float *Y, const float *bandE, int bandID, int N)
{ intensity_stereo((const CELTMode*)m, X, Y, bandE, bandID, N); }

void oracle_stereo_split(float *X, float *Y, int N) { stereo_split(X, Y, N); }

void oracle_stereo_merge(float *X, float *Y, float mid, int N, int arch) { stereo_merge(X, Y, mid, N, arch); }

void oracle_deinterleave_hadamard(float *X, int N0, int stride, int hadamard)
{ deinterleave_hadamard(X, N0, stride, hadamard); }

void oracle_interleave_hadamard(float *X, int N0, int stride, int hadamard)
{ interleave_hadamard(X, N0, stride, hadamard); }

int oracle_compute_qn(int N, int b, int offset, int pulse_cap, int stereo)
{ return compute_qn(N, b, offset, pulse_cap, stereo); }

void oracle_compute_theta(void *ctx, void *sctx, float *X, float *Y, int N, int *b, int B, int B0,
      int LM, int stereo, int *fill)
{ compute_theta((struct band_ctx*)ctx, (struct split_ctx*)sctx, X, Y, N, b, B, B0, LM, stereo, fill); }

unsigned oracle_quant_band_n1(void *ctx, float *X, float *Y, float *lowband_out)
{ return quant_band_n1((struct band_ctx*)ctx, X, Y, lowband_out); }

unsigned oracle_quant_partition(void *ctx, float *X, int N, int b, int B, float *lowband, int LM,
      float gain, int fill)
{ return quant_partition((struct band_ctx*)ctx, X, N, b, B, lowband, LM, gain, fill); }

unsigned oracle_quant_band(void *ctx, float *X, int N, int b, int B, float *lowband, int LM,
      float *lowband_out, float gain, float *lowband_scratch, int fill)
{ return quant_band((struct band_ctx*)ctx, X, N, b, B, lowband, LM, lowband_out, gain, lowband_scratch, fill); }

unsigned oracle_quant_band_stereo(void *ctx, float *X, float *Y, int N, int b, int B, float *lowband,
      int LM, float *lowband_out, float *lowband_scratch, int fill)
{ return quant_band_stereo((struct band_ctx*)ctx, X, Y, N, b, B, lowband, LM, lowband_out, lowband_scratch, fill); }

void oracle_special_hybrid_folding(const void *m, float *norm, float *norm2, int start, int M, int dual_stereo)
{ special_hybrid_folding((const CELTMode*)m, norm, norm2, start, M, dual_stereo); }

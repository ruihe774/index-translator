/* Header-only inlines / macros (static inline in arch.h, mathops.h, pitch.h, rate.h, ...)
   exposed as oracle_<name>. Kernels that the fork overrides with WASM SIMD (celt_inner_prod,
   dual_inner_prod, xcorr_kernel) go through the dispatching macros; the *_c variants are the
   scalar C versions. */
#ifdef HAVE_CONFIG_H
#include "config.h"
#endif
#include "arch.h"
#include "mathops.h"
#include "pitch.h"
#include "rate.h"
#include "modes.h"

float oracle_fast_atan2f(float y, float x) { return fast_atan2f(y, x); }
float oracle_celt_maxabs16(const float *x, int len) { return celt_maxabs16(x, len); }
float oracle_celt_atan_norm(float x) { return celt_atan_norm(x); }
float oracle_celt_atan2p_norm(float y, float x) { return celt_atan2p_norm(y, x); }
float oracle_celt_cos_norm2(float x) { return celt_cos_norm2(x); }
float oracle_celt_log2(float x) { return celt_log2(x); }
float oracle_celt_exp2(float x) { return celt_exp2(x); }

int oracle_get_pulses(int i) { return get_pulses(i); }
int oracle_bits2pulses(const void *m, int band, int LM, int bits) { return bits2pulses((const CELTMode*)m, band, LM, bits); }
int oracle_pulses2bits(const void *m, int band, int LM, int pulses) { return pulses2bits((const CELTMode*)m, band, LM, pulses); }

void oracle_xcorr_kernel(const float *x, const float *y, float sum[4], int len) { xcorr_kernel(x, y, sum, len, 0); }
void oracle_xcorr_kernel_c(const float *x, const float *y, float sum[4], int len) { xcorr_kernel_c(x, y, sum, len); }
float oracle_celt_inner_prod(const float *x, const float *y, int N) { return celt_inner_prod(x, y, N, 0); }
float oracle_celt_inner_prod_c(const float *x, const float *y, int N) { return celt_inner_prod_c(x, y, N); }
void oracle_dual_inner_prod(const float *x, const float *y01, const float *y02, int N, float *xy1, float *xy2)
{ dual_inner_prod(x, y01, y02, N, xy1, xy2, 0); }
void oracle_dual_inner_prod_c(const float *x, const float *y01, const float *y02, int N, float *xy1, float *xy2)
{ dual_inner_prod_c(x, y01, y02, N, xy1, xy2); }

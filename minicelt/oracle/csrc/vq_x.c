/* celt/vq.c with its static functions exposed as oracle_<name>. */
#include "vq.c"

void oracle_exp_rotation1(float *X, int len, int stride, float c, float s) { exp_rotation1(X, len, stride, c, s); }

void oracle_normalise_residual(int *iy, float *X, int N, float Ryy, float gain, int shift)
{ normalise_residual(iy, X, N, Ryy, gain, shift); }

unsigned oracle_extract_collapse_mask(int *iy, int N, int B) { return extract_collapse_mask(iy, N, B); }

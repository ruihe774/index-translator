/* celt/pitch.c with its static functions exposed as oracle_<name>. */
#include "pitch.c"

void oracle_find_best_pitch(float *xcorr, float *y, int len, int max_pitch, int *best_pitch)
{ find_best_pitch(xcorr, y, len, max_pitch, best_pitch); }

void oracle_celt_fir5(float *x, const float *num, int N) { celt_fir5(x, num, N); }

float oracle_compute_pitch_gain(float xy, float xx, float yy) { return compute_pitch_gain(xy, xx, yy); }

const int *oracle_second_check(void) { return second_check; }  /* [16] */

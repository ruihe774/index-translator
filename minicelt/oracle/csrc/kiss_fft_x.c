/* celt/kiss_fft.c with its static functions exposed as oracle_<name>. */
#include "kiss_fft.c"

void oracle_kf_bfly2(void *Fout, int m, int N) { kf_bfly2((kiss_fft_cpx*)Fout, m, N); }
void oracle_kf_bfly4(void *Fout, size_t fstride, const void *st, int m, int N, int mm)
{ kf_bfly4((kiss_fft_cpx*)Fout, fstride, (const kiss_fft_state*)st, m, N, mm); }
void oracle_kf_bfly3(void *Fout, size_t fstride, const void *st, int m, int N, int mm)
{ kf_bfly3((kiss_fft_cpx*)Fout, fstride, (const kiss_fft_state*)st, m, N, mm); }
void oracle_kf_bfly5(void *Fout, size_t fstride, const void *st, int m, int N, int mm)
{ kf_bfly5((kiss_fft_cpx*)Fout, fstride, (const kiss_fft_state*)st, m, N, mm); }

/* celt/cwrs.c with its static functions exposed as oracle_<name>. */
#include "cwrs.c"

opus_uint32 oracle_icwrs(int _n, const int *_y) { return icwrs(_n, _y); }
opus_val32 oracle_cwrsi(int _n, int _k, opus_uint32 _i, int *_y) { return cwrsi(_n, _k, _i, _y); }
const opus_uint32 *oracle_CELT_PVQ_U_DATA(void) { return CELT_PVQ_U_DATA; }  /* [1272] */

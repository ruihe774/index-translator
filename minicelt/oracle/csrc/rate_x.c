/* celt/rate.c with its static functions and tables exposed as oracle_<name>. */
#include "rate.c"

int oracle_interp_bits2pulses(const void *m, int start, int end, int skip_start, const int *bits1,
      const int *bits2, const int *thresh, const int *cap, opus_int32 total, opus_int32 *_balance,
      int skip_rsv, int *intensity, int intensity_rsv, int *dual_stereo, int dual_stereo_rsv,
      int *bits, int *ebits, int *fine_priority, int C, int LM, void *ec, int encode, int prev,
      int signalBandwidth)
{ return interp_bits2pulses((const CELTMode*)m, start, end, skip_start, bits1, bits2, thresh, cap, total,
      _balance, skip_rsv, intensity, intensity_rsv, dual_stereo, dual_stereo_rsv, bits, ebits,
      fine_priority, C, LM, (ec_ctx*)ec, encode, prev, signalBandwidth); }

const unsigned char *oracle_LOG2_FRAC_TABLE(void) { return LOG2_FRAC_TABLE; }  /* [24] */

/* celt/celt_encoder.c with its static functions exposed as oracle_<name>. */
#include "celt_encoder.c"
#include "layout.h"

#define OPUS_ENC_FIELDS(X) \
   X(mode) X(channels) X(stream_channels) X(force_intra) X(clip) X(disable_pf) X(complexity) \
   X(upsample) X(start) X(end) X(bitrate) X(vbr) X(signalling) X(constrained_vbr) X(loss_rate) \
   X(lsb_depth) X(lfe) X(disable_inv) X(arch) X(rng) X(spread_decision) X(delayedIntra) \
   X(tonal_average) X(lastCodedBands) X(hf_average) X(tapset_decision) X(prefilter_period) \
   X(prefilter_gain) X(prefilter_tapset) X(consec_transient) X(analysis) X(silk_info) \
   X(preemph_memE) X(preemph_memD) X(vbr_reservoir) X(vbr_drift) X(vbr_offset) X(vbr_count) \
   X(overlap_max) X(stereo_saving) X(intensity) X(energy_mask) X(spec_avg) X(in_mem)
#define X(f) L_OFF(struct OpusCustomEncoder, f),
const struct oracle_layout_entry oracle_celt_encoder_layout[] = {
   L_SIZE(struct OpusCustomEncoder), L_SIZE(AnalysisInfo), L_SIZE(SILKInfo),
   OPUS_ENC_FIELDS(X)
   L_END
};
#undef X

int oracle_opus_custom_encoder_init_arch(void *st, const void *mode, int channels, int arch)
{ return opus_custom_encoder_init_arch((CELTEncoder*)st, (const CELTMode*)mode, channels, arch); }

int oracle_transient_analysis(const float *in, int len, int C, float *tf_estimate, int *tf_chan,
      int allow_weak_transients, int *weak_transient, float tone_freq, float toneishness)
{ return transient_analysis(in, len, C, tf_estimate, tf_chan, allow_weak_transients, weak_transient, tone_freq, toneishness); }

int oracle_patch_transient_decision(float *newE, float *oldE, int nbEBands, int start, int end, int C)
{ return patch_transient_decision(newE, oldE, nbEBands, start, end, C); }

void oracle_compute_mdcts(const void *mode, int shortBlocks, float *in, float *out, int C, int CC,
      int LM, int upsample, int arch)
{ compute_mdcts((const CELTMode*)mode, shortBlocks, in, out, C, CC, LM, upsample, arch); }

float oracle_l1_metric(const float *tmp, int N, int LM, float bias)
{ return l1_metric(tmp, N, LM, bias); }

int oracle_tf_analysis(const void *m, int len, int isTransient, int *tf_res, int lambda, float *X,
      int N0, int LM, float tf_estimate, int tf_chan, int *importance)
{ return tf_analysis((const CELTMode*)m, len, isTransient, tf_res, lambda, X, N0, LM, tf_estimate, tf_chan, importance); }

void oracle_tf_encode(int start, int end, int isTransient, int *tf_res, int LM, int tf_select, void *enc)
{ tf_encode(start, end, isTransient, tf_res, LM, tf_select, (ec_enc*)enc); }

int oracle_alloc_trim_analysis(const void *m, const float *X, const float *bandLogE, int end, int LM,
      int C, int N0, void *analysis, float *stereo_saving, float tf_estimate, int intensity,
      float surround_trim, opus_int32 equiv_rate, int arch)
{ return alloc_trim_analysis((const CELTMode*)m, X, bandLogE, end, LM, C, N0, (AnalysisInfo*)analysis,
      stereo_saving, tf_estimate, intensity, surround_trim, equiv_rate, arch); }

int oracle_stereo_analysis(const void *m, const float *X, int LM, int N0)
{ return stereo_analysis((const CELTMode*)m, X, LM, N0); }

float oracle_median_of_5(const float *x) { return median_of_5(x); }
float oracle_median_of_3(const float *x) { return median_of_3(x); }

float oracle_dynalloc_analysis(const float *bandLogE, const float *bandLogE2, const float *oldBandE,
      int nbEBands, int start, int end, int C, int *offsets, int lsb_depth, const opus_int16 *logN,
      int isTransient, int vbr, int constrained_vbr, const opus_int16 *eBands, int LM,
      int effectiveBytes, opus_int32 *tot_boost_, int lfe, float *surround_dynalloc,
      void *analysis, int *importance, int *spread_weight, float tone_freq, float toneishness)
{ return dynalloc_analysis(bandLogE, bandLogE2, oldBandE, nbEBands, start, end, C, offsets, lsb_depth,
      logN, isTransient, vbr, constrained_vbr, eBands, LM, effectiveBytes, tot_boost_, lfe,
      surround_dynalloc, (AnalysisInfo*)analysis, importance, spread_weight, tone_freq, toneishness); }

int oracle_tone_lpc(const float *x, int len, int delay, float *lpc)
{ return tone_lpc(x, len, delay, lpc); }

float oracle_tone_detect(const float *in, int CC, int N, float *toneishness, opus_int32 Fs)
{ return tone_detect(in, CC, N, toneishness, Fs); }

int oracle_run_prefilter(void *st, float *in, float *prefilter_mem, int CC, int N, int prefilter_tapset,
      int *pitch, float *gain, int *qgain, int enabled, int complexity, float tf_estimate,
      int nbAvailableBytes, void *analysis, float tone_freq, float toneishness)
{ return run_prefilter((CELTEncoder*)st, in, prefilter_mem, CC, N, prefilter_tapset, pitch, gain, qgain,
      enabled, complexity, tf_estimate, nbAvailableBytes, (AnalysisInfo*)analysis, tone_freq, toneishness); }

int oracle_compute_vbr(const void *mode, void *analysis, opus_int32 base_target, int LM,
      opus_int32 bitrate, int lastCodedBands, int C, int intensity, int constrained_vbr,
      float stereo_saving, int tot_boost, float tf_estimate, int pitch_change, float maxDepth,
      int lfe, int has_surround_mask, float surround_masking, float temporal_vbr)
{ return compute_vbr((const CELTMode*)mode, (AnalysisInfo*)analysis, base_target, LM, bitrate,
      lastCodedBands, C, intensity, constrained_vbr, stereo_saving, tot_boost, tf_estimate,
      pitch_change, maxDepth, lfe, has_surround_mask, surround_masking, temporal_vbr); }

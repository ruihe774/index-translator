/* src/opus_encoder.c with its static functions exposed as oracle_<name>, the private
   OpusEncoder layout, and a getter for the embedded CELTEncoder. */
#include "opus_encoder.c"
#include "layout.h"

#define X(f) L_OFF(struct OpusEncoder, f),
const struct oracle_layout_entry oracle_opus_encoder_layout[] = {
   L_SIZE(struct OpusEncoder),
   X(celt_enc_offset) X(silk_enc_offset) X(application) X(channels) X(delay_compensation)
   X(force_channels) X(signal_type) X(user_bandwidth) X(max_bandwidth) X(user_forced_mode)
   X(voice_ratio) X(Fs) X(use_vbr) X(vbr_constraint) X(variable_duration) X(bitrate_bps)
   X(user_bitrate_bps) X(lsb_depth) X(encoder_buffer) X(lfe) X(arch) X(use_dtx) X(fec_config)
   X(analysis) X(stream_channels) X(hybrid_stereo_width_Q14) X(variable_HP_smth2_Q15)
   X(prev_HB_gain) X(hp_mem) X(mode) X(prev_mode) X(prev_channels) X(prev_framesize)
   X(bandwidth) X(auto_bandwidth) X(silk_bw_switch) X(first) X(energy_masking) X(width_mem)
   X(detected_bandwidth) X(nb_no_activity_ms_Q1) X(peak_signal_energy) X(nonfinal_frame)
   X(rangeFinal) X(delay_buffer)
   L_END
};
#undef X

/* The CELTEncoder embedded in an OpusEncoder. */
void *oracle_opus_get_celt_encoder(OpusEncoder *st) { return (char*)st + st->celt_enc_offset; }

unsigned char oracle_gen_toc(int mode, int framerate, int bandwidth, int channels)
{ return gen_toc(mode, framerate, bandwidth, channels); }

void oracle_silk_biquad_res(const float *in, const opus_int32 *B_Q28, const opus_int32 *A_Q28, float *S,
      float *out, opus_int32 len, int stride)
{ silk_biquad_res(in, B_Q28, A_Q28, S, out, len, stride); }

void oracle_hp_cutoff(const float *in, opus_int32 cutoff_Hz, float *out, float *hp_mem, int len,
      int channels, opus_int32 Fs, int arch)
{ hp_cutoff(in, cutoff_Hz, out, hp_mem, len, channels, Fs, arch); }

void oracle_dc_reject(const float *in, opus_int32 cutoff_Hz, float *out, float *hp_mem, int len,
      int channels, opus_int32 Fs)
{ dc_reject(in, cutoff_Hz, out, hp_mem, len, channels, Fs); }

void oracle_stereo_fade(const float *in, float *out, float g1, float g2, int overlap48, int frame_size,
      int channels, const float *window, opus_int32 Fs)
{ stereo_fade(in, out, g1, g2, overlap48, frame_size, channels, window, Fs); }

void oracle_gain_fade(const float *in, float *out, float g1, float g2, int overlap48, int frame_size,
      int channels, const float *window, opus_int32 Fs)
{ gain_fade(in, out, g1, g2, overlap48, frame_size, channels, window, Fs); }

opus_int32 oracle_user_bitrate_to_bitrate(OpusEncoder *st, int frame_size, int max_data_bytes)
{ return user_bitrate_to_bitrate(st, frame_size, max_data_bytes); }

int oracle_decide_fec(int useInBandFEC, int PacketLoss_perc, int last_fec, int mode, int *bandwidth, opus_int32 rate)
{ return decide_fec(useInBandFEC, PacketLoss_perc, last_fec, mode, bandwidth, rate); }

int oracle_compute_silk_rate_for_hybrid(int rate, int bandwidth, int frame20ms, int vbr, int fec, int channels)
{ return compute_silk_rate_for_hybrid(rate, bandwidth, frame20ms, vbr, fec, channels); }

opus_int32 oracle_compute_equiv_rate(opus_int32 bitrate, int channels, int frame_rate, int vbr, int mode,
      int complexity, int loss)
{ return compute_equiv_rate(bitrate, channels, frame_rate, vbr, mode, complexity, loss); }

float oracle_compute_frame_energy(const float *pcm, int frame_size, int channels, int arch)
{ return compute_frame_energy(pcm, frame_size, channels, arch); }

int oracle_decide_dtx_mode(int activity, int *nb_no_activity_ms_Q1, int frame_size_ms_Q1)
{ return decide_dtx_mode(activity, nb_no_activity_ms_Q1, frame_size_ms_Q1); }

int oracle_compute_redundancy_bytes(opus_int32 max_data_bytes, opus_int32 bitrate_bps, int frame_rate, int channels)
{ return compute_redundancy_bytes(max_data_bytes, bitrate_bps, frame_rate, channels); }

opus_int32 oracle_opus_encode_frame_native(OpusEncoder *st, const float *pcm, int frame_size,
      unsigned char *data, opus_int32 max_data_bytes, int float_api, int first_frame, void *analysis_info,
      int is_silence, int redundancy, int celt_to_silk, int prefill, opus_int32 equiv_rate, int to_celt)
{ return opus_encode_frame_native(st, pcm, frame_size, data, max_data_bytes, float_api, first_frame,
      (AnalysisInfo*)analysis_info, is_silence, redundancy, celt_to_silk, prefill, equiv_rate, to_celt); }

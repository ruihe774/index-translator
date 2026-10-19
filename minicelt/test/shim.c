/* Non-variadic wrappers over the libopus API, for Deno FFI (which cannot call
 * the variadic opus_*_ctl). The encoder is configured as minicelt is fixed:
 * 48 kHz RESTRICTED_CELT, 20 ms frames, VBR. */
#include <opus.h>

#define FRAME 960

OpusEncoder *shim_enc_create(int channels, int bitrate, int complexity, int vbr_constraint, int dtx, int *err) {
    OpusEncoder *st = opus_encoder_create(48000, channels, OPUS_APPLICATION_RESTRICTED_CELT, err);
    if (*err != OPUS_OK) return 0;
    if ((*err = opus_encoder_ctl(st, OPUS_SET_BITRATE(bitrate))) != OPUS_OK ||
        (*err = opus_encoder_ctl(st, OPUS_SET_COMPLEXITY(complexity))) != OPUS_OK ||
        (*err = opus_encoder_ctl(st, OPUS_SET_VBR(1))) != OPUS_OK ||
        (*err = opus_encoder_ctl(st, OPUS_SET_VBR_CONSTRAINT(vbr_constraint))) != OPUS_OK ||
        (*err = opus_encoder_ctl(st, OPUS_SET_DTX(dtx))) != OPUS_OK) {
        opus_encoder_destroy(st);
        return 0;
    }
    return st;
}
void shim_enc_destroy(OpusEncoder *st) { opus_encoder_destroy(st); }
int shim_enc_set_bitrate(OpusEncoder *st, int v) { return opus_encoder_ctl(st, OPUS_SET_BITRATE(v)); }
int shim_enc_set_complexity(OpusEncoder *st, int v) { return opus_encoder_ctl(st, OPUS_SET_COMPLEXITY(v)); }
int shim_enc_set_vbr_constraint(OpusEncoder *st, int v) { return opus_encoder_ctl(st, OPUS_SET_VBR_CONSTRAINT(v)); }
int shim_enc_set_dtx(OpusEncoder *st, int v) { return opus_encoder_ctl(st, OPUS_SET_DTX(v)); }
int shim_enc_set_packet_loss_perc(OpusEncoder *st, int v) { return opus_encoder_ctl(st, OPUS_SET_PACKET_LOSS_PERC(v)); }
int shim_enc_set_bandwidth(OpusEncoder *st, int v) { return opus_encoder_ctl(st, OPUS_SET_BANDWIDTH(v)); }
int shim_enc_lookahead(OpusEncoder *st) { opus_int32 v = 0; opus_encoder_ctl(st, OPUS_GET_LOOKAHEAD(&v)); return v; }
unsigned shim_enc_final_range(OpusEncoder *st) { opus_uint32 v = 0; opus_encoder_ctl(st, OPUS_GET_FINAL_RANGE(&v)); return v; }
int shim_enc_in_dtx(OpusEncoder *st) { opus_int32 v = 0; opus_encoder_ctl(st, OPUS_GET_IN_DTX(&v)); return v; }
/* pcm: FRAME interleaved samples per channel */
int shim_encode(OpusEncoder *st, const opus_int16 *pcm, unsigned char *out, int cap) { return opus_encode(st, pcm, FRAME, out, cap); }
int shim_encode_float(OpusEncoder *st, const float *pcm, unsigned char *out, int cap) { return opus_encode_float(st, pcm, FRAME, out, cap); }

OpusDecoder *shim_dec_create(int channels, int *err) { return opus_decoder_create(48000, channels, err); }
void shim_dec_destroy(OpusDecoder *st) { opus_decoder_destroy(st); }
/* Returns samples decoded per channel (or error); pcm must hold FRAME*channels samples. */
int shim_decode(OpusDecoder *st, const unsigned char *data, int len, opus_int16 *pcm) { return opus_decode(st, data, len, pcm, FRAME, 0); }
unsigned shim_dec_final_range(OpusDecoder *st) { opus_uint32 v = 0; opus_decoder_ctl(st, OPUS_GET_FINAL_RANGE(&v)); return v; }
const char *shim_version(void) { return opus_get_version_string(); }

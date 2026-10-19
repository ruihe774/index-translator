/* Non-variadic wrappers around opus_encoder_ctl, and mode helpers. */
#ifdef HAVE_CONFIG_H
#include "config.h"
#endif
#include "opus.h"
#include "opus_private.h"
#include "modes.h"
#include "layout.h"

extern CELTMode *opus_custom_mode_create(opus_int32 Fs, int frame_size, int *error);

int oracle_enc_set_bitrate(OpusEncoder *st, opus_int32 v) { return opus_encoder_ctl(st, OPUS_SET_BITRATE(v)); }
int oracle_enc_set_complexity(OpusEncoder *st, opus_int32 v) { return opus_encoder_ctl(st, OPUS_SET_COMPLEXITY(v)); }
int oracle_enc_set_vbr(OpusEncoder *st, opus_int32 v) { return opus_encoder_ctl(st, OPUS_SET_VBR(v)); }
int oracle_enc_set_vbr_constraint(OpusEncoder *st, opus_int32 v) { return opus_encoder_ctl(st, OPUS_SET_VBR_CONSTRAINT(v)); }
int oracle_enc_set_dtx(OpusEncoder *st, opus_int32 v) { return opus_encoder_ctl(st, OPUS_SET_DTX(v)); }
int oracle_enc_set_lsb_depth(OpusEncoder *st, opus_int32 v) { return opus_encoder_ctl(st, OPUS_SET_LSB_DEPTH(v)); }
int oracle_enc_set_packet_loss(OpusEncoder *st, opus_int32 v) { return opus_encoder_ctl(st, OPUS_SET_PACKET_LOSS_PERC(v)); }
int oracle_enc_reset(OpusEncoder *st) { return opus_encoder_ctl(st, OPUS_RESET_STATE); }
int oracle_enc_get_final_range(OpusEncoder *st, opus_uint32 *v) { return opus_encoder_ctl(st, OPUS_GET_FINAL_RANGE(v)); }
int oracle_enc_get_in_dtx(OpusEncoder *st, opus_int32 *v) { return opus_encoder_ctl(st, OPUS_GET_IN_DTX(v)); }
int oracle_enc_get_lookahead(OpusEncoder *st, opus_int32 *v) { return opus_encoder_ctl(st, OPUS_GET_LOOKAHEAD(v)); }
int oracle_enc_get_bitrate(OpusEncoder *st, opus_int32 *v) { return opus_encoder_ctl(st, OPUS_GET_BITRATE(v)); }

/* The static 48 kHz / 960 mode (mode48000_960_120). */
const void *oracle_mode48000(void) { return opus_custom_mode_create(48000, 960, NULL); }

struct oracle_mode_info {
   int Fs, overlap, nbEBands, effEBands, maxLM, nbShortMdcts, shortMdctSize, nbAllocVectors;
   const opus_int16 *eBands;
   const float *window;
   const opus_int16 *logN;
   const unsigned char *allocVectors;
   const opus_int16 *cache_index;
   const unsigned char *cache_bits;
   const unsigned char *cache_caps;
   const void *mdct;      /* &mode->mdct (mdct_lookup) */
   const void *kfft[4];   /* mode->mdct.kfft[0..3] (kiss_fft_state *) */
   int cache_size;
   float preemph[4];
   int mdct_n, mdct_maxshift;
   const float *mdct_trig;
};

void oracle_mode_info(const void *mode, struct oracle_mode_info *o)
{
   const CELTMode *m = (const CELTMode*)mode;
   int i;
   o->Fs = m->Fs; o->overlap = m->overlap; o->nbEBands = m->nbEBands; o->effEBands = m->effEBands;
   o->maxLM = m->maxLM; o->nbShortMdcts = m->nbShortMdcts;
   o->shortMdctSize = m->shortMdctSize; o->nbAllocVectors = m->nbAllocVectors;
   o->eBands = m->eBands; o->window = m->window; o->logN = m->logN; o->allocVectors = m->allocVectors;
   o->cache_index = m->cache.index; o->cache_bits = m->cache.bits; o->cache_caps = m->cache.caps;
   o->cache_size = m->cache.size;
   o->mdct = &m->mdct;
   for (i = 0; i < 4; i++) o->preemph[i] = m->preemph[i];
   o->mdct_n = m->mdct.n; o->mdct_maxshift = m->mdct.maxshift; o->mdct_trig = m->mdct.trig;
   for (i = 0; i < 4; i++) o->kfft[i] = m->mdct.kfft[i];
}

const struct oracle_layout_entry oracle_mode_layout[] = {
   L_SIZE(CELTMode), L_SIZE(mdct_lookup), L_SIZE(kiss_fft_state), L_SIZE(PulseCache),
   L_END
};

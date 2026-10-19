/* Replaces libopus src/analysis.c in the minicelt test reference: minicelt does not port the
 * tonality analysis, so the reference must not run it either. Every caller treats
 * analysis_info->valid == 0 as "no analysis", which is also what libopus does at complexity < 7. */
#include "analysis.h"

void tonality_analysis_init(TonalityAnalysisState *tonal, opus_int32 Fs) { (void)tonal; (void)Fs; }
void tonality_analysis_reset(TonalityAnalysisState *tonal) { (void)tonal; }
void tonality_get_info(TonalityAnalysisState *tonal, AnalysisInfo *info_out, int len) {
    (void)tonal; (void)len;
    info_out->valid = 0;
}
void run_analysis(TonalityAnalysisState *analysis, const CELTMode *celt_mode, const void *analysis_pcm,
                  int analysis_frame_size, int frame_size, int c1, int c2, int C, opus_int32 Fs,
                  int lsb_depth, downmix_func downmix, AnalysisInfo *analysis_info) {
    (void)analysis; (void)celt_mode; (void)analysis_pcm; (void)analysis_frame_size; (void)frame_size;
    (void)c1; (void)c2; (void)C; (void)Fs; (void)lsb_depth; (void)downmix;
    analysis_info->valid = 0;
}

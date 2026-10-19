/* Stand-in for src/analysis.c (+ mlp.c, mlp_data.c): minicelt has no tonality analysis, so
   the reference is built without it. Every symbol other files reference is defined here and
   leaves `analysis_info->valid == 0`, which is what the Rust port assumes. */
#ifdef HAVE_CONFIG_H
#include "config.h"
#endif
#include "analysis.h"

void tonality_analysis_init(TonalityAnalysisState *tonal, opus_int32 Fs)
{
   (void)Fs;
   /* Same effect as the real one for the fields opus_encoder.c reads. */
   tonal->initialized = 0;
   tonal->read_pos = 0;
   tonal->read_subframe = 0;
}

void tonality_analysis_reset(TonalityAnalysisState *tonal)
{
   tonal->initialized = 0;
   tonal->read_pos = 0;
   tonal->read_subframe = 0;
}

void tonality_get_info(TonalityAnalysisState *tonal, AnalysisInfo *info_out, int len)
{
   (void)tonal;
   (void)len;
   info_out->valid = 0;
}

void run_analysis(TonalityAnalysisState *analysis, const CELTMode *celt_mode, const void *analysis_pcm,
                 int analysis_frame_size, int frame_size, int c1, int c2, int C, opus_int32 Fs,
                 int lsb_depth, downmix_func downmix, AnalysisInfo *analysis_info)
{
   (void)analysis; (void)celt_mode; (void)analysis_pcm; (void)analysis_frame_size;
   (void)frame_size; (void)c1; (void)c2; (void)C; (void)Fs; (void)lsb_depth; (void)downmix;
   analysis_info->valid = 0;
}

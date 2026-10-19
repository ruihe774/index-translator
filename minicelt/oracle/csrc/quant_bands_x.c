/* celt/quant_bands.c with its static functions and tables exposed as oracle_<name>. */
#include "quant_bands.c"

float oracle_loss_distortion(const float *eBands, float *oldEBands, int start, int end, int len, int C)
{ return loss_distortion(eBands, oldEBands, start, end, len, C); }

int oracle_quant_coarse_energy_impl(const void *m, int start, int end, const float *eBands,
      float *oldEBands, opus_int32 budget, opus_int32 tell, const unsigned char *prob_model,
      float *error, void *enc, int C, int LM, int intra, float max_decay, int lfe)
{ return quant_coarse_energy_impl((const CELTMode*)m, start, end, eBands, oldEBands, budget, tell,
      prob_model, error, (ec_enc*)enc, C, LM, intra, max_decay, lfe); }

const unsigned char *oracle_e_prob_model(void) { return &e_prob_model[0][0][0]; }  /* [4][2][42] */
const unsigned char *oracle_small_energy_icdf(void) { return small_energy_icdf; }  /* [3] */
const float *oracle_pred_coef(void) { return pred_coef; }                          /* [4] */
const float *oracle_beta_coef(void) { return beta_coef; }                          /* [4] */
float oracle_beta_intra(void) { return beta_intra; }

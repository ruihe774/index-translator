//! Port of silk/check_control_input.c.
//!
//! The C version also has `celt_assert( 0 )` before each error return (active only in
//! assertion builds); here the error codes are simply returned, as in a non-assertion C build.

use crate::silk::define::*;
use crate::silk::structs::silk_EncControlStruct;

/// Check encoder control struct
pub fn check_control_input(
    encControl: &silk_EncControlStruct, /* I    Control structure                           */
) -> i32 {
    let fs_ok = |fs: i32| fs == 8000 || fs == 12000 || fs == 16000;
    let api = encControl.API_sampleRate;
    if (api != 8000 && api != 12000 && api != 16000 && api != 24000 && api != 32000 && api != 44100 && api != 48000)
        || !fs_ok(encControl.desiredInternalSampleRate)
        || !fs_ok(encControl.maxInternalSampleRate)
        || !fs_ok(encControl.minInternalSampleRate)
        || encControl.minInternalSampleRate > encControl.desiredInternalSampleRate
        || encControl.maxInternalSampleRate < encControl.desiredInternalSampleRate
        || encControl.minInternalSampleRate > encControl.maxInternalSampleRate
    {
        return SILK_ENC_FS_NOT_SUPPORTED;
    }
    if encControl.payloadSize_ms != 10
        && encControl.payloadSize_ms != 20
        && encControl.payloadSize_ms != 40
        && encControl.payloadSize_ms != 60
    {
        return SILK_ENC_PACKET_SIZE_NOT_SUPPORTED;
    }
    if encControl.packetLossPercentage < 0 || encControl.packetLossPercentage > 100 {
        return SILK_ENC_INVALID_LOSS_RATE;
    }
    if encControl.useDTX < 0 || encControl.useDTX > 1 {
        return SILK_ENC_INVALID_DTX_SETTING;
    }
    if encControl.useCBR < 0 || encControl.useCBR > 1 {
        return SILK_ENC_INVALID_CBR_SETTING;
    }
    if encControl.useInBandFEC < 0 || encControl.useInBandFEC > 1 {
        return SILK_ENC_INVALID_INBAND_FEC_SETTING;
    }
    if encControl.nChannelsAPI < 1 || encControl.nChannelsAPI > ENCODER_NUM_CHANNELS {
        return SILK_ENC_INVALID_NUMBER_OF_CHANNELS_ERROR;
    }
    if encControl.nChannelsInternal < 1 || encControl.nChannelsInternal > ENCODER_NUM_CHANNELS {
        return SILK_ENC_INVALID_NUMBER_OF_CHANNELS_ERROR;
    }
    if encControl.nChannelsInternal > encControl.nChannelsAPI {
        return SILK_ENC_INVALID_NUMBER_OF_CHANNELS_ERROR;
    }
    if encControl.complexity < 0 || encControl.complexity > 10 {
        return SILK_ENC_INVALID_COMPLEXITY_SETTING;
    }

    SILK_NO_ERROR
}

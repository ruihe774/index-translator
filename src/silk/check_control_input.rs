//! Port of silk/check_control_input.c.
//!
//! The C version also has `celt_assert( 0 )` before each error return (active only in
//! assertion builds); here the error codes are simply returned, as in the oracle build.

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{CSilkEncoder, Rng};

    mod c {
        use crate::silk::structs::silk_EncControlStruct;
        unsafe extern "C" {
            pub fn check_control_input(encControl: *mut silk_EncControlStruct) -> i32;
        }
    }

    #[test]
    fn matches_c() {
        let base = CSilkEncoder::new(20000, 5, false).ctl;
        let mut rng = Rng::new(77);
        let rates = [0, 8000, 12000, 16000, 24000, 32000, 44100, 48000, 96000, 11025];
        for it in 0..5000 {
            let mut ctl = base;
            if it > 0 {
                match rng.range(0, 9) {
                    0 => ctl.API_sampleRate = rates[rng.range(0, 9) as usize],
                    1 => ctl.desiredInternalSampleRate = rates[rng.range(0, 4) as usize],
                    2 => ctl.maxInternalSampleRate = rates[rng.range(0, 4) as usize],
                    3 => ctl.minInternalSampleRate = rates[rng.range(0, 4) as usize],
                    4 => ctl.payloadSize_ms = rng.range(-1, 61),
                    5 => ctl.packetLossPercentage = rng.range(-2, 102),
                    6 => {
                        ctl.useDTX = rng.range(-1, 2);
                        ctl.useCBR = rng.range(-1, 2);
                        ctl.useInBandFEC = rng.range(-1, 2);
                    }
                    7 => {
                        ctl.nChannelsAPI = rng.range(0, 3);
                        ctl.nChannelsInternal = rng.range(0, 3);
                    }
                    _ => ctl.complexity = rng.range(-1, 11),
                }
            }
            // The C oracle is built with ENCODER_NUM_CHANNELS == 2; minisilk is mono-only.
            let mut cc = ctl;
            let expect = unsafe { c::check_control_input(&mut cc) };
            let got = check_control_input(&ctl);
            if ctl.nChannelsAPI == 2 || ctl.nChannelsInternal == 2 {
                assert!(expect == SILK_NO_ERROR || expect == got || got == SILK_ENC_INVALID_NUMBER_OF_CHANNELS_ERROR);
            } else {
                assert_eq!(got, expect, "it {it}");
            }
        }
    }
}

#![cfg_attr(not(test), no_std)]

#[cfg(test)]
extern crate oracle;

#[cfg(test)]
mod tests {
    #[test]
    fn oracle_links() {
        let mut enc = oracle::RefEncoder::new(24000, 5, false);
        let mut dec = oracle::RefDecoder::new();
        let pcm: [i16; 320] = core::array::from_fn(|i| ((i as f32 * 0.2).sin() * 8000.0) as i16);
        let mut pkt = [0u8; 1500];
        let mut out = [0i16; 320];
        for _ in 0..5 {
            let n = enc.encode(&pcm, &mut pkt);
            assert!(n > 0);
            assert_eq!(dec.decode(&pkt[..n as usize], &mut out), 320);
        }
    }
}

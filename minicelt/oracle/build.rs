//! Builds the float libopus (with the fork's WASM SIMD kernels) with wasi-sdk as the test
//! reference. The SIMD variant follows the Rust target features: relaxed-simd on ->
//! -mrelaxed-simd. `src/analysis.c`, `mlp.c`, `mlp_data.c` are replaced by `csrc/analysis_stub.c`.
//! Files with static functions that tests need are compiled through wrapper TUs
//! (`csrc/*_x.c`, which `#include` the original .c and export `oracle_<name>`).

use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

fn mk_list(src: &Path, mk: &str, var: &str) -> Vec<String> {
    let text = std::fs::read_to_string(src.join(mk)).unwrap();
    let mut out = Vec::new();
    let mut inside = false;
    for line in text.lines() {
        if !inside {
            inside = line.split('=').next().is_some_and(|l| l.trim() == var) && line.contains('=');
            continue;
        }
        if line.trim().is_empty() {
            break;
        }
        out.extend(line.split_whitespace().filter(|w| w.ends_with(".c")).map(String::from));
    }
    assert!(!out.is_empty(), "{var} not found in {mk}");
    out
}

/// Sources replaced by a wrapper TU in csrc/ (which includes the original).
const WRAPPED: &[(&str, &str)] = &[
    ("celt/celt_encoder.c", "celt_encoder_x.c"),
    ("celt/bands.c", "bands_x.c"),
    ("celt/vq.c", "vq_x.c"),
    ("celt/quant_bands.c", "quant_bands_x.c"),
    ("celt/rate.c", "rate_x.c"),
    ("celt/cwrs.c", "cwrs_x.c"),
    ("celt/pitch.c", "pitch_x.c"),
    ("celt/kiss_fft.c", "kiss_fft_x.c"),
    ("src/opus_encoder.c", "opus_encoder_x.c"),
];
/// Sources replaced by the analysis stub.
const DROPPED: &[&str] = &["src/analysis.c", "src/mlp.c", "src/mlp_data.c"];
/// Extra TUs without an original (header inlines, shims, stubs).
const EXTRA: &[&str] = &["inlines_x.c", "shim.c", "analysis_stub.c"];

fn main() {
    let target = env::var("TARGET").unwrap();
    assert_eq!(target, "wasm32-wasip1", "the oracle only builds for wasm32-wasip1");
    let home = env::var("HOME").unwrap_or_default();
    let sdk = ["WASI_SDK_PATH"]
        .iter()
        .filter_map(|v| env::var(v).ok())
        .map(PathBuf::from)
        .chain([PathBuf::from("/opt/wasi-sdk"), PathBuf::from(format!("{home}/opt/wasi-sdk-34.0"))])
        .find(|p| p.join("bin/clang").exists())
        .expect("wasi-sdk not found (set WASI_SDK_PATH)");
    let here = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    let features = env::var("CARGO_CFG_TARGET_FEATURE").unwrap_or_default();
    let relaxed = features.split(',').any(|f| f == "relaxed-simd");
    assert!(features.split(',').any(|f| f == "simd128"), "build with -Ctarget-feature=+simd128");

    // Fork branch v1.6.1-wasm-simd: upstream libopus 1.6.1 + the WASM SIMD kernels and hooks.
    let src = PathBuf::from(env::var("OPUS_SRC").unwrap_or("/home/user/opus-v1.6.1-wasm-simd".into()));
    assert!(src.join("celt_sources.mk").exists(), "OPUS_SRC {} is not a libopus tree", src.display());

    for v in ["WASI_SDK_PATH", "OPUS_SRC"] {
        println!("cargo:rerun-if-env-changed={v}");
    }
    println!("cargo:rerun-if-changed=csrc");
    for d in ["silk", "src", "celt", "include"] {
        println!("cargo:rerun-if-changed={}", src.join(d).display());
    }

    let mut files: Vec<PathBuf> = Vec::new();
    for (mk, var) in [
        ("opus_sources.mk", "OPUS_SOURCES"),
        ("opus_sources.mk", "OPUS_SOURCES_FLOAT"),
        ("celt_sources.mk", "CELT_SOURCES"),
        ("silk_sources.mk", "SILK_SOURCES"),
        ("silk_sources.mk", "SILK_SOURCES_FLOAT"),
        ("silk_sources.mk", "SILK_SOURCES_WASM_SIMD"),
        ("silk_sources.mk", "SILK_SOURCES_FLOAT_WASM_SIMD"),
        ("celt_sources.mk", "CELT_SOURCES_WASM_SIMD"),
    ] {
        for f in mk_list(&src, mk, var) {
            if DROPPED.contains(&f.as_str()) {
                continue;
            }
            match WRAPPED.iter().find(|(orig, _)| *orig == f) {
                Some((_, w)) => files.push(here.join("csrc").join(w)),
                None => files.push(src.join(&f)),
            }
        }
    }
    files.extend(EXTRA.iter().map(|f| here.join("csrc").join(f)));

    let clang = sdk.join("bin/clang");
    let mut args: Vec<String> = vec![
        format!("--target={target}"),
        format!("--sysroot={}", sdk.join("share/wasi-sysroot").display()),
        "-O2".into(),
        "-g".into(),
        "-msimd128".into(),
        // Only explicit relaxed_madd intrinsics may fuse; with contraction on, clang would
        // also fuse multiply-adds in loops it auto-vectorizes (with -mrelaxed-simd), making
        // the reference depend on the optimizer rather than on the source.
        "-ffp-contract=off".into(),
        "-DHAVE_CONFIG_H".into(),
        "-w".into(),
    ];
    if relaxed {
        args.push("-mrelaxed-simd".into());
    }
    args.push(format!("-I{}", here.join("csrc").display()));
    for inc in ["", "include", "celt", "silk", "silk/float", "src"] {
        args.push(format!("-I{}", src.join(inc).display()));
    }

    let objs: Vec<PathBuf> = files
        .iter()
        .map(|f| {
            let rel = f.strip_prefix(&src).unwrap_or_else(|_| f.strip_prefix(&here).unwrap());
            out.join(rel.to_string_lossy().replace('/', "_")).with_extension("o")
        })
        .collect();
    let next = AtomicUsize::new(0);
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get());
    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| {
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    if i >= files.len() {
                        break;
                    }
                    let st = Command::new(&clang)
                        .args(&args)
                        .arg("-c")
                        .arg(&files[i])
                        .arg("-o")
                        .arg(&objs[i])
                        .status()
                        .expect("failed to run wasi-sdk clang");
                    assert!(st.success(), "compiling {} failed", files[i].display());
                }
            });
        }
    });

    let lib = out.join("libopus_ref.a");
    let _ = std::fs::remove_file(&lib);
    let st = Command::new(sdk.join("bin/llvm-ar")).arg("rcs").arg(&lib).args(&objs).status().unwrap();
    assert!(st.success());
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=opus_ref");
}

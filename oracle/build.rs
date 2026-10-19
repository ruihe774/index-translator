//! Builds the full float libopus (with its WASM SIMD kernels) with wasi-sdk as the test reference.
//! The SIMD variant follows the Rust target features: relaxed-simd on -> -mrelaxed-simd.

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

fn main() {
    let target = env::var("TARGET").unwrap();
    assert_eq!(target, "wasm32-wasip1", "the oracle only builds for wasm32-wasip1");
    let home = env::var("HOME").unwrap();
    let sdk = PathBuf::from(env::var("WASI_SDK_PATH").unwrap_or(format!("{home}/opt/wasi-sdk-34.0")));
    let src = PathBuf::from(env::var("OPUS_SRC").unwrap_or("/mnt/workspace/opus".into()));
    let here = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    let features = env::var("CARGO_CFG_TARGET_FEATURE").unwrap_or_default();
    let relaxed = features.split(',').any(|f| f == "relaxed-simd");
    assert!(features.split(',').any(|f| f == "simd128"), "build with -Ctarget-feature=+simd128");

    for v in ["WASI_SDK_PATH", "OPUS_SRC"] {
        println!("cargo:rerun-if-env-changed={v}");
    }
    println!("cargo:rerun-if-changed=csrc");
    println!("cargo:rerun-if-changed={}", src.join("silk").display());
    println!("cargo:rerun-if-changed={}", src.join("src").display());
    println!("cargo:rerun-if-changed={}", src.join("celt").display());

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
        files.extend(mk_list(&src, mk, var).iter().map(|f| src.join(f)));
    }

    files.push(here.join("csrc/layout.c"));

    let clang = sdk.join("bin/clang");
    let mut args: Vec<String> = vec![
        "--target=wasm32-wasip1".into(),
        format!("--sysroot={}", sdk.join("share/wasi-sysroot").display()),
        "-O2".into(),
        "-g".into(),
        "-msimd128".into(),
        "-DHAVE_CONFIG_H".into(),
    ];
    if relaxed {
        args.push("-mrelaxed-simd".into());
    }
    for inc in ["", "include", "celt", "silk", "silk/float", "src"] {
        args.push(format!("-I{}", src.join(inc).display()));
    }
    args.insert(0, format!("-I{}", here.join("csrc").display()));

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

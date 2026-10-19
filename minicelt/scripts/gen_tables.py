#!/usr/bin/env python3
"""Converter of the libopus float static mode to Rust (kept for regeneration).

usage: gen_tables.py <opus-src> <out-dir>
Writes <out-dir>/static_modes_float.rs from celt/static_modes_float.h plus the tables of
celt/modes.c it references (eband5ms, band_allocation).

Configuration: float build, ENABLE_PFA / ENABLE_QEXT / CUSTOM_MODES / HAVE_ARM_NE10 undefined.
The header is run through a minimal preprocessor (#if/#ifdef/#ifndef/#else/#endif/#define with
that configuration) so only the live branch is converted; the 96 kHz QEXT mode drops out.
Float literals are parsed exactly and re-emitted as the shortest decimal that parses back to the
same f32 (verified here).
"""
import re
import sys
from fractions import Fraction
from pathlib import Path

DEFINED = set()  # no ENABLE_PFA, ENABLE_QEXT, CUSTOM_MODES, HAVE_ARM_NE10, OVERRIDE_FFT

TYPES = {
    "celt_coef": "f32", "opus_val16": "f32", "opus_int16": "i16", "unsigned char": "u8",
}


def strip_comments(s):
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.S)
    return re.sub(r"//[^\n]*", "", s)


def preprocess(text):
    """Keeps the live lines of `text`; handles the conditionals the header uses."""
    macros = set(DEFINED)
    out, stack = [], []  # stack of (active, taken, parent_active)
    active = True

    def cond(expr):
        expr = expr.strip()
        m = re.fullmatch(r"(!?)\s*defined\s*\(\s*(\w+)\s*\)", expr)
        assert m, f"unsupported #if expression: {expr}"
        return (m.group(2) in macros) != bool(m.group(1))

    for line in text.split("\n"):
        d = re.match(r"\s*#\s*(\w+)\s*(.*)", line)
        if not d:
            if active:
                out.append(line)
            continue
        k, arg = d.groups()
        if k in ("if", "ifdef", "ifndef"):
            if k == "ifdef":
                c = arg.split()[0] in macros
            elif k == "ifndef":
                c = arg.split()[0] not in macros
            else:
                c = cond(arg)
            stack.append((active, c and active))
            active = active and c
        elif k == "else":
            parent, taken = stack[-1]
            active = parent and not taken
            stack[-1] = (parent, True)
        elif k == "endif":
            active, _ = stack.pop()
        elif active and k == "define":
            macros.add(arg.split()[0].split("(")[0])
        elif active and k == "include":
            pass
        elif active:
            raise SystemExit(f"unsupported directive: {line}")
    assert not stack
    return "\n".join(out)


def parse_init(s, i):
    """Parses a brace initializer at s[i] == '{'. Returns (nested list of tokens, next index)."""
    assert s[i] == "{"
    i += 1
    out, tok = [], ""
    while True:
        c = s[i]
        if c == "{":
            v, i = parse_init(s, i)
            out.append(v)
            continue
        if c in ",}":
            if tok.strip():
                out.append(tok.strip())
            tok = ""
            i += 1
            if c == "}":
                return out, i
            continue
        tok += c
        i += 1


def parse_tables(text, only=None):
    """name -> (c type, declared length or None, initializer)."""
    tabs = {}
    pat = r"static\s+const\s+(celt_coef|opus_int16|unsigned\s+char|kiss_twiddle_cpx|opus_val16)\s+(\w+)\s*(\[[^\]]*\])?\s*=\s*"
    for m in re.finditer(pat, text):
        ty, name, dim = m.groups()
        if only and name not in only:
            continue
        v, _ = parse_init(text, m.end())
        tabs[name] = (re.sub(r"\s+", " ", ty), int(dim[1:-1]) if dim and dim[1:-1] else None, v)
    return tabs


# ---- exact float handling -------------------------------------------------------------------

def f32_bits(tok):
    """Correctly rounded (nearest-even) f32 bit pattern of a C float literal like -1.5e-3f."""
    t = tok.strip()
    assert t[-1] in "fF", tok
    t = t[:-1]
    neg = t.startswith("-")
    if neg:
        t = t[1:]
    x = Fraction(t)  # exact decimal
    if x == 0:
        return 0x80000000 if neg else 0
    # find e with 2^e <= x < 2^(e+1)
    e = x.numerator.bit_length() - x.denominator.bit_length()
    if Fraction(2) ** e > x:
        e -= 1
    assert x < 2 ** (e + 1) and 2 ** e <= x
    assert e >= -126, "denormal f32 literal not expected"
    q = x / Fraction(2) ** (e - 23)  # mantissa scaled to [2^23, 2^24)
    n = q.numerator // q.denominator
    r = q - n
    if r > Fraction(1, 2) or (r == Fraction(1, 2) and n & 1):
        n += 1
    if n == 1 << 24:
        n >>= 1
        e += 1
    assert e <= 127
    bits = ((e + 127) << 23) | (n & 0x7FFFFF)
    return bits | (0x80000000 if neg else 0)


def bits_to_fraction(b):
    s, e, m = b >> 31, (b >> 23) & 0xFF, b & 0x7FFFFF
    assert 0 < e < 255
    v = Fraction(m | 0x800000, 1 << 23) * Fraction(2) ** (e - 127)
    return -v if s else v


def rust_f32(tok):
    """Shortest Rust literal that parses (correctly rounded) to the same f32 as the C literal."""
    b = f32_bits(tok)
    if b & 0x7FFFFFFF == 0:
        return "-0.0" if b >> 31 else "0.0"
    exact = bits_to_fraction(b)
    for p in range(0, 12):
        s = f"{float(exact):.{p}e}"  # float() of an f32 value is exact
        mant, ex = s.split("e")
        if f32_bits(s + "f") == b:
            break
    else:
        raise SystemExit(f"no short literal for {tok}")
    ex = int(ex)
    if -4 <= ex <= 4 and mant.lstrip("-").replace(".", "").count("0") != len(mant):
        d = f"{float(exact):.{max(0, p - ex)}f}"
        if f32_bits(d + "f") == b:
            s = d if "." in d else d + ".0"
            return s
    if "." not in mant:
        mant += ".0"
    return f"{mant}e{ex}"


def check_literal(tok, lit):
    assert f32_bits(tok) == f32_bits(lit + "f"), (tok, lit)


# ---- emission -------------------------------------------------------------------------------

def wrap(items, indent, width=100, sep=", "):
    pad = " " * indent
    lines, line = [], ""
    for x in items:
        piece = x + sep.rstrip() + " "
        if line and len(pad) + len(line) + len(piece.rstrip()) > width:
            lines.append(pad + line.rstrip())
            line = ""
        line += piece
    if line:
        lines.append(pad + line.rstrip())
    return "\n".join(lines)


def int_lit(tok):
    assert re.fullmatch(r"-?\d+", tok), tok
    return tok


def pack(items, width=100, indent=4):
    """Greedy-wraps `items` (comma separated) to `width` columns."""
    lines, line = [], ""
    for x in items:
        piece = x + ","
        if line and indent + len(line) + 1 + len(piece) > width:
            lines.append(" " * indent + line)
            line = ""
        line = f"{line} {piece}" if line else piece
    if line:
        lines.append(" " * indent + line)
    return "\n".join(lines)


def emit_array(name, cty, decl_len, init, row=None):
    if cty == "kiss_twiddle_cpx":
        rty = "kiss_twiddle_cpx"
        items = []
        for e in init:
            assert len(e) == 2
            r, i = rust_f32(e[0]), rust_f32(e[1])
            check_literal(e[0], r)
            check_literal(e[1], i)
            items.append(f"kiss_twiddle_cpx {{ r: {r}, i: {i} }}")
        body = pack(items)
    else:
        rty = TYPES[cty]
        if rty == "f32":
            items = []
            for t in init:
                lit = rust_f32(t)
                check_literal(t, lit)
                items.append(lit)
        else:
            items = [int_lit(t) for t in init]
        if row:  # one logical row per line
            assert len(items) % row == 0
            body = "\n".join("    " + " ".join(x + "," for x in items[k:k + row])
                             for k in range(0, len(items), row))
        else:
            body = pack(items)
    n = len(init)
    assert decl_len is None or decl_len == n, (name, decl_len, n)
    return f"#[rustfmt::skip]\npub static {name}: [{rty}; {n}] = [\n{body}\n];\n"


def emit_fft_state(name, init):
    nfft, scale, shift, factors, bitrev, twiddles, arch_fft = init
    assert arch_fft == "NULL"  # dropped in Rust
    assert len(factors) == 16
    sc = rust_f32(scale)
    check_literal(scale, sc)
    fac = ", ".join(int_lit(f) for f in factors)
    return (f"static {name}: kiss_fft_state = kiss_fft_state {{\n"
            f"    nfft: {int_lit(nfft)},\n    scale: {sc},\n    shift: {int_lit(shift)},\n"
            f"    factors: [{fac}],\n    bitrev: &{bitrev},\n    twiddles: &{twiddles},\n}};\n")


def parse_mode(text):
    m = re.search(r"static\s+const\s+CELTMode\s+(\w+)\s*=\s*", text)
    name = m.group(1)
    v, _ = parse_init(text, m.end())
    return name, v


def main():
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    hdr = preprocess(strip_comments((src / "celt/static_modes_float.h").read_text()))
    modes_c = (src / "celt/modes.c").read_text()
    # modes.c tables referenced by the header (eband5ms, band_allocation); the `[]` length is
    # taken from the initializer.
    mc = parse_tables(strip_comments(modes_c), only=("eband5ms", "band_allocation"))
    for k in ("eband5ms", "band_allocation"):
        assert k in mc, k
    # kiss_fft_state objects are initialized positionally; the arrays go through parse_tables.
    tabs = parse_tables(hdr)
    states = {}
    for m in re.finditer(r"static\s+const\s+kiss_fft_state\s+(\w+)\s*=\s*", hdr):
        v, _ = parse_init(hdr, m.end())
        states[m.group(1)] = v
    mname, mode = parse_mode(hdr)
    tabs.pop(mname, None)
    (Fs, overlap, nbEBands, effEBands, preemph, eBands, maxLM, nbShortMdcts, shortMdctSize,
     nbAllocVectors, allocVectors, logN, window, mdct, cache) = mode
    assert (eBands, allocVectors) == ("eband5ms", "band_allocation")
    # Cross-checks with the modes.c tables.
    nb = len(mc["eband5ms"][2]) - 1
    assert nb == int(nbEBands) == int(effEBands)
    assert len(mc["band_allocation"][2]) == int(nbAllocVectors) * nb

    out = ["//! Port of celt/static_modes_float.h (generated by scripts/gen_tables.py from libopus 1.6.1)",
           "//!",
           "//! Also holds `eband5ms` and `band_allocation` from celt/modes.c. Float build, no",
           "//! ENABLE_PFA / ENABLE_QEXT / CUSTOM_MODES: only the 48 kHz / 960 mode.",
           "",
           "use super::kiss_fft::{kiss_fft_state, kiss_twiddle_cpx};",
           "use super::mdct::mdct_lookup;",
           "use super::modes::{CELTMode, PulseCache};",
           ""]

    def tab(name, t, row=None):
        out.append(emit_array(name, *t, row=row))

    tab("eband5ms", mc["eband5ms"])
    tab("band_allocation", mc["band_allocation"], row=nb)
    # Arrays in header order (definition order matters only to the reader).
    for name, t in tabs.items():
        tab(name, t)
    for name, init in states.items():
        assert init[4] in tabs and init[5] in tabs, name
        out.append(emit_fft_state(name, init))
    # mode
    wn, lg = window, logN
    pre = ", ".join(rust_f32(p) for p in preemph)
    for p in preemph:
        check_literal(p, rust_f32(p))
    n, maxshift, kf, trig = mdct
    assert len(kf) == 4 and all(k.startswith("&") for k in kf)
    kf = [k[1:] for k in kf]
    csize, cidx, cbits, ccaps = cache
    out.append(f"""pub static {mname}: CELTMode = CELTMode {{
    Fs: {int_lit(Fs)},
    overlap: {int_lit(overlap)},
    nbEBands: {int_lit(nbEBands)},
    effEBands: {int_lit(effEBands)},
    preemph: [{pre}],
    eBands: &{eBands},
    maxLM: {int_lit(maxLM)},
    nbShortMdcts: {int_lit(nbShortMdcts)},
    shortMdctSize: {int_lit(shortMdctSize)},
    nbAllocVectors: {int_lit(nbAllocVectors)},
    allocVectors: &{allocVectors},
    logN: &{lg},
    window: &{wn},
    mdct: mdct_lookup {{
        n: {int_lit(n)},
        maxshift: {int_lit(maxshift)},
        kfft: [\n{pack(["&" + k for k in kf], indent=12)}\n        ],
        trig: &{trig},
    }},
    cache: PulseCache {{
        size: {int_lit(csize)},
        index: &{cidx},
        bits: &{cbits},
        caps: &{ccaps},
    }},
}};
""")
    dst.mkdir(parents=True, exist_ok=True)
    (dst / "static_modes_float.rs").write_text("\n".join(out))
    print(f"{dst / 'static_modes_float.rs'}: {len(tabs) + 2} tables, {len(states)} fft states")


main()

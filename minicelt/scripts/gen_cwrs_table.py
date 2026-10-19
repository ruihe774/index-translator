#!/usr/bin/env python3
"""Extract CELT_PVQ_U_DATA (non-CWRS_EXTRA_ROWS variant) from celt/cwrs.c and print it as Rust.

usage: gen_cwrs_table.py path/to/celt/cwrs.c > table.rs
"""
import re, sys

src = open(sys.argv[1]).read().split("\n")
out, stack, active = [], [], True
for line in src:
    s = line.strip()
    m = re.match(r"#\s*if\s+(!?)defined\((\w+)\)", s)
    if m:
        # CWRS_EXTRA_ROWS is false in our configuration; others are not interesting here
        val = m.group(2) not in ("CWRS_EXTRA_ROWS", "CUSTOM_MODES", "ENABLE_QEXT", "SMALL_FOOTPRINT")
        if m.group(2) == "SMALL_FOOTPRINT": val = False
        if m.group(1): val = not val
        stack.append((active, val)); active = active and val
        continue
    if s.startswith("#else") and stack:
        outer, val = stack[-1]; stack[-1] = (outer, not val); active = outer and not val; continue
    if s.startswith("#endif") and stack:
        outer, _ = stack.pop(); active = outer; continue
    if active:
        out.append(line)
text = "\n".join(out)
m = re.search(r"CELT_PVQ_U_DATA\[(\d+)\]=\{(.*?)\};", text, re.S)
n = int(m.group(1))
body = re.sub(r"/\*.*?\*/", "", m.group(2), flags=re.S)
vals = [int(x) for x in re.findall(r"\d+", body)]
assert len(vals) == n, (len(vals), n)
print(f"pub static CELT_PVQ_U_DATA: [u32; {n}] = [")
for i in range(0, n, 10):
    print("    " + ", ".join(str(v) for v in vals[i:i+10]) + ",")
print("];")
m = re.search(r"CELT_PVQ_U_ROW\[15\]=\{(.*?)\};", text, re.S)
offs = [int(x) for x in re.findall(r"CELT_PVQ_U_DATA\+\s*(\d+)", m.group(1))]
assert len(offs) == 15
print(f"pub static CELT_PVQ_U_ROW: [usize; 15] = {offs};")

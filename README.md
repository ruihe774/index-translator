# Noto Sans Math, as WOFF2

`NotoSansMath-Regular.woff2` is `NotoSansMath-Regular.ttf` compressed to WOFF2, for the math in
index-translator's web app (Temml's stylesheet `Temml-NotoSans.css` names the font).

Source: https://github.com/notofonts/notofonts.github.io/blob/55773c3eb233b5a0eaa07de6226da189b136b4f0/fonts/NotoSansMath/full/ttf/NotoSansMath-Regular.ttf
(SHA-256 7283c396e9b22699bb542d9631030dc804a7e5b954f193d8f8f5b5f1162fbc61, 1,015,684 bytes).

Command (wawoff2 2.0.1, Google's woff2 compressor built to WebAssembly):

    bunx wawoff2 NotoSansMath-Regular.ttf NotoSansMath-Regular.woff2

Result: 344,084 bytes (gzip -9 of the TTF: 491,041; brotli: 404,045). The conversion is lossless:
fontTools reads back the same 5,130 glyph outlines, the same advance widths and the same cmap, and the same
set of tables.

`OFL.txt` is the font's license (https://github.com/notofonts/math/blob/9a787713b618795e51cb4c7ef6af357022cfc6ec/OFL.txt,
SHA-256 403a95275b469061b7d4371c328e0ada3bc7d63328abe2e88aad5cd243b2fe21). A compressed copy is a
modified version only in format; the font's name and glyphs are unchanged.

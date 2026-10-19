// usage: deno run --allow-read --allow-write --allow-run scripts/select-clips.ts <srcdir> <outdir>
// Picks short test clips from long recordings (the Xiph.org test media FLACs, see scripts/variance.ts --audio).
// Every *.flac in <srcdir> is scanned in 6 s segments; each segment gets a few cheap features, the segments
// ranking highest in each category (below) are cut to 48 kHz stereo 16-bit WAV files in <outdir>
// (at most 3 per category, at least 30 s apart within a file). Deterministic for the same inputs.
//   bright      second-difference energy / energy of the mid channel (high-frequency emphasis)
//   transient   loudest 20 ms frame vs the median frame
//   sustained   lowest spread of the 20 ms frame energies
//   wide / nearmono   highest / lowest side-to-mid energy ratio
//   quiet       -52..-40 dBFS, brightest
//   loud        highest level
const [src, out] = Deno.args;
if (!src || !out) throw new Error('usage: select-clips.ts <srcdir> <outdir>');
const SEG = 6, FS = 48000;
type Seg = { file: string; t: number; rms: number; bright: number; trans: number; steady: number; width: number };
const segs: Seg[] = [];
const files = [...Deno.readDirSync(src)].filter((e) => e.name.endsWith('.flac')).map((e) => e.name).sort();
for (const file of files) {
  const { stdout } = new Deno.Command('ffmpeg', { args: ['-v', 'error', '-i', `${src}/${file}`, '-f', 's16le', '-ac', '2', '-ar', String(FS), '-'] }).outputSync();
  const pcm = new Int16Array(stdout.buffer, stdout.byteOffset, stdout.length >> 1);
  const n = pcm.length / 2;
  const mid = (i: number) => (pcm[2 * i] + pcm[2 * i + 1]) / 2;
  for (let o = 0; o + SEG * FS <= n; o += SEG * FS) {
    let e = 0, e2 = 0, es = 0, fe = 0;
    const fr: number[] = [];
    for (let i = 0; i < SEG * FS; i++) {
      const m = mid(o + i), s = (pcm[2 * (o + i)] - pcm[2 * (o + i) + 1]) / 2;
      e += m * m; es += s * s; fe += m * m;
      if (i >= 2) { const d = m - 2 * mid(o + i - 1) + mid(o + i - 2); e2 += d * d; }
      if ((i + 1) % 960 === 0) { fr.push(fe); fe = 0; }
    }
    const sorted = [...fr].sort((a, b) => a - b), med = sorted[fr.length >> 1] + 1;
    const meanFr = fr.reduce((a, b) => a + b, 0) / fr.length;
    const sdFr = Math.sqrt(fr.reduce((a, b) => a + (b - meanFr) ** 2, 0) / fr.length);
    segs.push({
      file: file.replace(/\.flac$/, ''), t: o / FS,
      rms: 10 * Math.log10(e / (SEG * FS) / 32768 ** 2 + 1e-12),
      bright: 10 * Math.log10((e2 + 1) / (e + 1)),
      trans: 10 * Math.log10((sorted[fr.length - 1] + 1) / med),
      steady: sdFr / (meanFr + 1),
      width: 10 * Math.log10((es + 1) / (e + 1)),
    });
  }
  console.log(file, `${(n / FS).toFixed(0)} s`, segs.length, 'segments so far');
}
const cats: [string, (s: Seg) => boolean, (s: Seg) => number][] = [
  ['bright', (s) => s.rms > -35, (s) => s.bright],
  ['transient', (s) => s.rms > -35, (s) => s.trans],
  ['sustained', (s) => s.rms > -30, (s) => -s.steady],
  ['wide', (s) => s.rms > -35, (s) => s.width],
  ['nearmono', (s) => s.rms > -30, (s) => -s.width],
  ['quiet', (s) => s.rms < -40 && s.rms > -52, (s) => s.bright],
  ['loud', () => true, (s) => s.rms],
];
Deno.mkdirSync(out, { recursive: true });
const chosen: Seg[] = [], rows: string[] = [];
for (const [cat, ok, score] of cats) {
  let k = 0;
  for (const s of segs.filter(ok).sort((a, b) => score(b) - score(a))) {
    if (k >= 3) break;
    if (chosen.some((c) => c.file === s.file && Math.abs(c.t - s.t) < 30)) continue;
    chosen.push(s); k++;
    const name = `${cat}_${s.file.replace(/[^A-Za-z0-9]+/g, '-')}_${String(s.t).padStart(4, '0')}s.wav`;
    new Deno.Command('ffmpeg', { args: ['-v', 'error', '-y', '-ss', String(s.t), '-t', String(SEG), '-i', `${src}/${s.file}.flac`, '-ac', '2', '-ar', String(FS), '-c:a', 'pcm_s16le', `${out}/${name}`] }).outputSync();
    rows.push(`${name}  rms ${s.rms.toFixed(1)} dB  bright ${s.bright.toFixed(1)}  trans ${s.trans.toFixed(1)}  steady ${s.steady.toFixed(2)}  side/mid ${s.width.toFixed(1)} dB`);
  }
}
console.log(rows.join('\n'));

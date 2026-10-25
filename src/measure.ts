import type { Audio, Metrics, Samples, Stats, Stimulus, Traces } from './types.js';

export const db = (value: number): number | null => value > 0 ? 20 * Math.log10(value) : null;
export function amplitude(x: Samples, sr: number, hz: number): number {
  // Solve the three-column least-squares system (sin, cos, DC), including fractional bins.
  let ss = 0, cc = 0, sc = 0, s = 0, c = 0, ys = 0, yc = 0, y = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.sin(2 * Math.PI * hz * i / sr), b = Math.cos(2 * Math.PI * hz * i / sr); ss += a * a; cc += b * b; sc += a * b; s += a; c += b; ys += x[i] * a; yc += x[i] * b; y += x[i]; }
  const m = [[ss, sc, s, ys], [sc, cc, c, yc], [s, c, x.length, y]];
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let row = col + 1; row < 3; row++) if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    if (Math.abs(m[col][col]) < 1e-12) return 0;
    const scale = m[col][col]; for (let j = col; j < 4; j++) m[col][j] /= scale;
    for (let row = 0; row < 3; row++) if (row !== col) { const factor = m[row][col]; for (let j = col; j < 4; j++) m[row][j] -= factor * m[col][j]; }
  }
  return Math.hypot(m[0][3], m[1][3]);
}
export function stats(audio: Audio): Stats[] {
  return audio.map(channel => {
    let peak = 0, sum = 0, power = 0, full = 0;
    for (const v of channel) { peak = Math.max(peak, Math.abs(v)); sum += v; power += v * v; if (Math.abs(v) >= 1) full++; }
    const rms = Math.sqrt(power / channel.length);
    return { peak_dbfs: db(peak), rms_dbfs: db(rms), dc: sum / channel.length, crest_db: rms ? db(peak / rms) : null, full_scale_fraction: full / channel.length, digital_silence: peak === 0 };
  });
}
export function fft(real: Float64Array, imag: Float64Array) {
  const n = real.length;
  if (n < 2 || (n & (n - 1)) !== 0 || imag.length !== n) throw new Error('FFT requires equal power-of-two arrays');
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { [real[i], real[j]] = [real[j], real[i]]; [imag[i], imag[j]] = [imag[j], imag[i]]; }
  }
  for (let size = 2; size <= n; size *= 2) {
    const angle = -2 * Math.PI / size, wr = Math.cos(angle), wi = Math.sin(angle);
    for (let offset = 0; offset < n; offset += size) {
      let r = 1, im = 0;
      for (let j = 0; j < size / 2; j++) {
        const a = offset + j, b = a + size / 2, tr = r * real[b] - im * imag[b], ti = r * imag[b] + im * real[b];
        real[b] = real[a] - tr; imag[b] = imag[a] - ti; real[a] += tr; imag[a] += ti;
        const next = r * wr - im * wi; im = r * wi + im * wr; r = next;
      }
    }
  }
}
export function spectrum(x: Samples): [Float64Array, Float64Array] {
  const n = x.length;
  if ((n & (n - 1)) === 0) { const r = Float64Array.from(x), i = new Float64Array(n); fft(r, i); return [r, i]; }
  // Bluestein's convolution keeps arbitrary analysis windows exact without an FFT dependency.
  const m = 2 ** Math.ceil(Math.log2(2 * n - 1)), ar = new Float64Array(m), ai = new Float64Array(m), br = new Float64Array(m), bi = new Float64Array(m);
  for (let j = 0; j < n; j++) {
    const angle = Math.PI * (j * j % (2 * n)) / n, c = Math.cos(angle), s = Math.sin(angle);
    ar[j] = x[j] * c; ai[j] = -x[j] * s; br[j] = c; bi[j] = s;
    if (j) { br[m - j] = c; bi[m - j] = s; }
  }
  fft(ar, ai); fft(br, bi);
  for (let j = 0; j < m; j++) { const r = ar[j] * br[j] - ai[j] * bi[j]; ai[j] = -(ar[j] * bi[j] + ai[j] * br[j]); ar[j] = r; }
  fft(ar, ai);
  const r = new Float64Array(n), im = new Float64Array(n);
  for (let j = 0; j < n; j++) { const angle = Math.PI * (j * j % (2 * n)) / n, c = Math.cos(angle), s = Math.sin(angle); r[j] = (ar[j] * c - ai[j] * s) / m; im[j] = (-ai[j] * c - ar[j] * s) / m; }
  return [r, im];
}
export function measure(x: Audio, y: Audio, sr: number, stimulus: Stimulus): [Metrics, Traces] {
  const count = Math.min(x[0].length, y[0].length);
  if (count < 32 || y.length !== x.length || y.some(ch => ch.some(v => !Number.isFinite(v)))) throw new Error('Measurement needs matching channels and >=32 finite output frames');
  const start = Math.max(0, count - sr), channel = stimulus.probe_dbfs !== undefined ? 1 : 0, xi = x[channel].subarray(start, count), yo = y[channel].subarray(start, count);
  const metrics: Metrics = { input: stats(x), output: stats(y), analysis_channel: channel, analysis_window_seconds: [start / sr, count / sr], alignment: 'raw host output, no automatic latency compensation', gain_db: null, thd_db: null };
  const kind = stimulus.kind ?? 'tone', hz = stimulus.frequency_hz ?? 1000, gated = kind === 'resonance' && (stimulus.on_seconds !== undefined || stimulus.off_seconds !== undefined);
  const sustained = channel === 1 || !gated || start / sr >= (stimulus.on_seconds ?? x[0].length / sr / 3) && count / sr <= (stimulus.off_seconds ?? x[0].length / sr * 2 / 3);
  if (['tone', 'resonance'].includes(kind) && sustained && stimulus.probe_kind !== 'noise') {
    const ai = amplitude(xi, sr, hz), ao = amplitude(yo, sr, hz);
    Object.assign(metrics, { frequency_hz: hz, input_tone_peak_dbfs: db(ai), output_tone_peak_dbfs: db(ao), gain_db: ai > 1e-10 ? db(ao / ai) : null });
    if (kind === 'tone' && ao > 1e-10) {
      let power = 0, harmonics = 0;
      for (let h = 2; h <= Math.min(10, Math.floor(sr * .49 / hz)); h++) { power += amplitude(yo, sr, hz * h) ** 2; harmonics++; }
      metrics.thd_db = harmonics ? db(Math.sqrt(power) / ao) : null;
    }
  }
  if (kind === 'impulse') {
    let incoming = 0, peak = 0, total = 0, before = 0;
    for (let i = 0; i < x[channel].length; i++) if (Math.abs(x[channel][i]) > Math.abs(x[channel][incoming])) incoming = i;
    for (let i = 0; i < y[channel].length; i++) { if (Math.abs(y[channel][i]) > Math.abs(y[channel][peak])) peak = i; total += y[channel][i] ** 2; }
    if (Math.abs(y[channel][peak]) > 1e-12) { for (let i = 0; i < peak; i++) before += y[channel][i] ** 2; metrics.impulse_peak_lag_samples = peak - incoming; metrics.energy_before_output_peak_fraction = before / total; }
  }
  const n = Math.min(yo.length, 65536), windowed = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) { const window = .5 - .5 * Math.cos(2 * Math.PI * i / (n - 1)); sum += window; windowed[i] = yo[yo.length - n + i] * window; }
  const [real, imag] = spectrum(windowed);
  const bins = Math.floor(n / 2), points = Math.min(512, bins);
  const indices = new Set(Array.from({ length: points }, (_, i) => Math.floor(Math.exp(i * Math.log(bins) / (points - 1)))));
  const traceSpectrum = [...indices].map(k => ({ hz: k * sr / n, dbfs: db(2 * Math.hypot(real[k], imag[k]) / Math.max(sum, 1)) }));
  const block = Math.max(32, Math.round(.02 * sr)), envelope: Traces['rms_envelope'] = [];
  for (let a = 0; a + block <= count; a += block) {
    let pi = 0, po = 0; for (let i = a; i < a + block; i++) { pi += x[channel][i] ** 2; po += y[channel][i] ** 2; }
    envelope.push({ seconds: (a + block / 2) / sr, input_rms_dbfs: db(Math.sqrt(pi / block)), output_rms_dbfs: db(Math.sqrt(po / block)) });
  }
  return [metrics, { spectrum: traceSpectrum, rms_envelope: envelope, conventions: 'spectrum: Hann FFT-bin peak amplitude, not PSD; envelope: raw 20 ms RMS, not attack/release time constant' }];
}

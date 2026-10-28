import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadAudio } from './archive.js';
import { arraySha, dump, expand, fields, load, number, sha } from './io.js';
import { amplitude, db, spectrum, stats } from './measure.js';
import { safeId, verifiedCase, verifiedRun } from './integrity.js';
import type { Result, Samples, State } from './types.js';
import { aligned, candidateError } from './audio-error.js';
export { aligned } from './audio-error.js';

export function archive(directory: string, caseId: string) {
  const state = verifiedRun(directory);
  if (state.status !== 'ok' || state.kind !== 'measurements') throw new Error('Comparison requires a completed measurement run');
  if (!safeId(caseId)) throw new Error('Invalid comparison case ID');
  const entry = state.cases.find(c => c.id === caseId), folder = join(directory, 'cases', caseId);
  if (!entry || entry.status !== 'ok' || !entry.artifacts?.['audio.npz'] || !entry.artifacts['result.json']) throw new Error(`Missing successful archived case: ${caseId}`);
  const result = verifiedCase(directory, entry);
  const { input, output, sample_rate: sr } = loadAudio(join(folder, 'audio.npz'));
  if (input[0].length < 32 || output[0].length < 32 || input.length !== output.length || output[0].length > input[0].length || sr !== state.spec.sample_rate) throw new Error('Comparison audio shape/sample rate mismatch');
  if (arraySha(input) !== result.input_sha256 || arraySha(output) !== result.output_sha256) throw new Error('Audio array checksum mismatch');
  const stimulus = state.spec.cases.find(c => c.id === caseId)?.stimulus;
  if (!stimulus) throw new Error('Missing case in plan');
  return { state, result, stimulus, input, output, sr };
}
function windowed(x: Samples, offset: number, n: number): [Float64Array, Float64Array] {
  return spectrum(Float64Array.from({ length: n }, (_, i) => x[offset + i] * (.5 - .5 * Math.cos(2 * Math.PI * i / (n - 1)))));
}
export function response(x: Samples, y: Samples, sr: number, frequencies: number[]) {
  const n = Math.min(8192, x.length), bins = Math.floor(n / 2) + 1, px = new Float64Array(bins), py = new Float64Array(bins), cr = new Float64Array(bins), ci = new Float64Array(bins);
  let segments = 0;
  for (let s = 0; s + n <= x.length; s += Math.floor(n / 2)) {
    const [xr, xi] = windowed(x, s, n), [yr, yi] = windowed(y, s, n); segments++;
    for (let k = 0; k < bins; k++) { px[k] += xr[k] ** 2 + xi[k] ** 2; py[k] += yr[k] ** 2 + yi[k] ** 2; cr[k] += yr[k] * xr[k] + yi[k] * xi[k]; ci[k] += yi[k] * xr[k] - yr[k] * xi[k]; }
  }
  let max = 0; for (const p of px) max = Math.max(max, p);
  return frequencies.map(hz => {
    const k = Math.min(Math.round(hz * n / sr), bins - 1), excited = px[k] > Math.max(max * 1e-10, 1e-24), cross = Math.hypot(cr[k], ci[k]);
    return { requested_hz: hz, bin_hz: k * sr / n, segments, input_bin_peak_dbfs: db(2 * Math.sqrt(px[k] / segments) / ((n - 1) / 2)), output_bin_peak_dbfs: db(2 * Math.sqrt(py[k] / segments) / ((n - 1) / 2)), h1_gain_db: excited ? db(cross / px[k]) : null, h1_phase_degrees: excited && cross > 1e-24 ? Math.atan2(ci[k], cr[k]) * 180 / Math.PI : null, coherence: segments >= 2 && excited && py[k] > 0 ? Math.max(0, Math.min(1, cross ** 2 / (px[k] * py[k]))) : null };
  });
}
function list(value: unknown, name: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${name} requires a list with <=${max} entries`);
  return value;
}
function pair(value: unknown, name: string, lo: number, hi: number): [number, number] {
  const items = list(value, name, 2); if (items.length !== 2) throw new Error(`${name} requires [start, end]`);
  return [number(items[0], name, lo, hi), number(items[1], name, lo, hi)];
}
export function compare(directory: string, output: string, value: unknown) {
  directory = expand(directory); output = expand(output);
  const options = fields(value, ['case_ids', 'candidate_run', 'frequencies_hz', 'window_seconds', 'band_hz', 'times_seconds', 'window_ms', 'lag_samples', 'candidate_lag_samples', 'reference_floor_dbfs'], 'comparison option');
  const state = load<State>(join(directory, 'run.json')), ids = list(options.case_ids ?? state.cases.map(c => c.id), 'case_ids', 16);
  if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !safeId(id))) throw new Error('Select 1..16 distinct safe case IDs');
  const frequencies = list(options.frequencies_hz ?? [], 'frequencies_hz', 32), times = list(options.times_seconds ?? [], 'times_seconds', 32);
  if (times.length && options.band_hz === undefined) throw new Error('times_seconds requires band_hz');
  if (options.candidate_lag_samples !== undefined && options.candidate_run === undefined) throw new Error('candidate_lag_samples requires candidate_run');
  if (options.candidate_run !== undefined && typeof options.candidate_run !== 'string') throw new Error('candidate_run must be a path');
  const windowMs = number(options.window_ms ?? 80, 'window_ms', 1, 2000), lag = number(options.lag_samples ?? 0, 'lag_samples', -4_000_000, 4_000_000), candidateLag = number(options.candidate_lag_samples ?? 0, 'candidate_lag_samples', -4_000_000, 4_000_000);
  const rows = (ids as string[]).map(id => {
    const ref = archive(directory, id), { sr, stimulus, result } = ref;
    const hzList = frequencies.map(hz => number(hz, 'frequency', 1, sr * .49));
    let candidate: Result['metrics'] | null = null;
    let comparison: (ReturnType<typeof candidateError> & { candidate_identity: State['identity']; candidate_run_sha256: string; relative_error_db: (number | null)[] }) | null = null;
    if (options.candidate_run) {
      const candidateDir = expand(options.candidate_run as string), cand = archive(candidateDir, id);
      if (cand.sr !== sr || cand.input.length !== ref.input.length || arraySha(cand.input) !== arraySha(ref.input) || cand.input[0].length !== ref.input[0].length) throw new Error(`Candidate inputs must match exactly: ${id}`);
      if (cand.output[0].length !== ref.output[0].length) throw new Error('Candidate/reference output lengths must match; no implicit trimming');
      const error = candidateError(ref.output, cand.output, sr, candidateLag, options.window_seconds, options.reference_floor_dbfs);
      comparison = { ...error, candidate_identity: cand.state.identity, candidate_run_sha256: sha(join(candidateDir, 'run.json')), relative_error_db: error.channels.map(c => c.relative_error_db) };
      candidate = cand.result.metrics;
    }
    const [x, y] = aligned(ref.input, ref.output, lag), seconds = x[0].length / sr, [start, end] = pair(options.window_seconds ?? [Math.max(0, seconds - 1), seconds], 'window_seconds', 0, seconds), a = Math.round(start * sr), b = Math.round(end * sr);
    if (b - a < 32) throw new Error('Analysis window requires >=32 frames');
    const channels = x.map((ch, c) => {
      const xi = ch.subarray(a, b), yo = y[c].subarray(a, b), hz = stimulus.frequency_hz ?? 1000;
      let gain: number | null = null;
      const gated = stimulus.kind === 'resonance' && (stimulus.on_seconds !== undefined || stimulus.off_seconds !== undefined), offset = Math.max(0, -lag) / sr;
      const sustained = c === 1 && stimulus.probe_dbfs !== undefined || !gated || start + offset >= (stimulus.on_seconds ?? ref.state.spec.duration / 3) && end + offset <= (stimulus.off_seconds ?? ref.state.spec.duration * 2 / 3);
      if (['tone', 'resonance'].includes(stimulus.kind ?? 'tone') && sustained && !(c === 1 && stimulus.probe_kind === 'noise')) { const ai = amplitude(xi, sr, hz); gain = ai > 1e-10 ? db(amplitude(yo, sr, hz) / ai) : null; }
      const envelope: { seconds: number; band_gain_db: number | null }[] = [];
      if (options.band_hz !== undefined) {
        const [lo, hi] = pair(options.band_hz, 'band_hz', 0, sr / 2), n = Math.round(sr * windowMs / 1000), k0 = Math.ceil(lo * n / sr), k1 = Math.floor(hi * n / sr);
        if (lo >= hi || k0 > k1 || n < 32 || n > x[0].length) throw new Error('Band/window must contain FFT bins and >=32 available samples');
        for (const time of times) {
          const t = number(time, 'times_seconds', windowMs / 2000, seconds - windowMs / 2000), s = Math.round(t * sr) - Math.floor(n / 2);
          if (s < 0 || s + n > ch.length) throw new Error('Time-band window exceeds aligned audio');
          const [xr, xi] = windowed(ch, s, n), [yr, yi] = windowed(y[c], s, n); let px = 0, py = 0;
          for (let k = k0; k <= k1; k++) { px += xr[k] ** 2 + xi[k] ** 2; py += yr[k] ** 2 + yi[k] ** 2; }
          envelope.push({ seconds: t, band_gain_db: px > 1e-24 ? db(Math.sqrt(py / px)) : null });
        }
      }
      return { channel: c, tone_gain_db: gain, spectral_transfer: hzList.length ? response(xi, yo, sr, hzList) : [], band_envelope: envelope };
    });
    return { id, parameters: result.plugin!.parameters, reported_latency_samples: result.plugin!.reported_latency_samples, impulse_peak_lag_samples: result.metrics?.impulse_peak_lag_samples ?? null, window_seconds: [start, end], channels, candidate_metrics: candidate ?? null, comparison };
  });
  const limits = [
    'H1 magnitude and wrapped phase are descriptive cross-spectrum estimates, not proof of LTI or an FFT implementation. Low coherence makes them unreliable. Phase includes uncompensated delay; it is not group delay or minimum-phase classification. Single-segment coherence is undefined. Bin levels are Hann-windowed, averaged sine-equivalent peak amplitudes, not PSD or distortion attribution.',
    'Tone gains use the selected steady-state window. Band envelopes use Hann-windowed FFT energy, not calibrated attack/release constants.',
    'Null comparisons require matching archived inputs; only caller-selected lag is applied. An explicit window_seconds also restricts candidate error, on the original reference clock. With no window, candidate error covers the full aligned overlap (tone/spectral analysis retains its last-second default). reference_floor_dbfs only changes the reported relative denominator; absolute error and audio remain unmodified.',
    'Artifact hashes detect accidental changes; they do not authenticate an adversarially rewritten run.',
  ];
  mkdirSync(dirname(output), { recursive: true }); mkdirSync(output);
  dump(join(output, 'comparison.json'), { status: 'ok', reference_run_sha256: sha(join(directory, 'run.json')), identity: state.identity, options, cases: rows, limits });
  const lines = ['# Fourier run comparison', '', `Reference: \`${directory.replaceAll('`', '')}\``, '', '| Case | Channel | Tone gain (dB) | Reported latency | Impulse lag |', '|---|---:|---:|---:|---:|'];
  for (const row of rows) for (const ch of row.channels) lines.push(`| ${row.id} | ${ch.channel} | ${ch.tone_gain_db ?? '—'} | ${row.reported_latency_samples} | ${row.impulse_peak_lag_samples ?? '—'} |`);
  if (frequencies.length) {
    lines.push('', '## Spectral estimates', '', '| Case | Channel | Bin (Hz) | H1 gain (dB) | Wrapped phase (degrees) | Coherence | Input bin (peak dBFS) | Output bin (peak dBFS) |', '|---|---:|---:|---:|---:|---:|---:|---:|');
    for (const row of rows) for (const ch of row.channels) for (const f of ch.spectral_transfer) lines.push(`| ${row.id} | ${ch.channel} | ${f.bin_hz} | ${f.h1_gain_db} | ${f.h1_phase_degrees} | ${f.coherence} | ${f.input_bin_peak_dbfs} | ${f.output_bin_peak_dbfs} |`);
  }
  if (times.length) {
    lines.push('', '## Time-band estimates', '', '| Case | Channel | Time (seconds) | Band gain (dB) |', '|---|---:|---:|---:|');
    for (const row of rows) for (const ch of row.channels) for (const point of ch.band_envelope) lines.push(`| ${row.id} | ${ch.channel} | ${point.seconds} | ${point.band_gain_db} |`);
  }
  lines.push('', 'Detailed measurements and readbacks: [comparison.json](comparison.json)', '', ...limits);
  writeFileSync(join(output, 'COMPARISON.md'), lines.join('\n') + '\n');
  return { status: 'ok', directory: output, report: join(output, 'comparison.json'), cases: rows.map(row => ({ id: row.id, channel_tone_gains_db: row.channels.map(c => c.tone_gain_db), candidate_relative_error_db: row.comparison?.relative_error_db ?? null, candidate_rms_error_dbfs: row.comparison?.channels.map(c => c.rms_error_dbfs) ?? null, candidate_exact_null: row.comparison?.channels.map(c => c.exact_null) ?? null })) };
}

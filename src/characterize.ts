import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { archive } from './compare.js';
import { dump, expand, fields, integer, load, number, sha } from './io.js';
import { amplitude, db } from './measure.js';
import { echoResponse, modulationTrace } from './effects.js';
import type { Samples, State } from './types.js';

export function decayCurve(samples: Samples, sr: number, start: number) {
  const energy = new Float64Array(samples.length - start); let sum = 0;
  for (let i = samples.length - 1; i >= start; i--) { sum += samples[i] ** 2; energy[i - start] = sum; }
  if (sum < 1e-24) return null;
  const curve = energy.map(v => v > 0 ? 10 * Math.log10(v / sum) : -Infinity);
  const fit = (high: number, low: number) => {
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0, first = -1, last = -1;
    for (let i = 0; i < curve.length; i++) if (curve[i] <= high && curve[i] >= low) {
      const x = i / sr, y = curve[i]; if (first < 0) first = i; last = i;
      n++; sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y;
    }
    if (n < 8 || first < 0 || curve[curve.length - 1] > low || curve[first] < high - 1 || curve[last] > low + 1) return null;
    const xx = n * sxx - sx * sx, yy = n * syy - sy * sy, xy = n * sxy - sx * sy, slope = xy / xx;
    if (!(slope < 0) || !(xx > 0) || !(yy > 0)) return null;
    return { extrapolated_rt60_seconds: -60 / slope, slope_db_per_second: slope, r_squared: Math.max(0, Math.min(1, xy * xy / (xx * yy))), fitted_db: [high, low], fitted_seconds: [first / sr, last / sr], points: n };
  };
  const stride = Math.max(1, Math.ceil(curve.length / 512));
  return { start_seconds: start / sr, edt: fit(0, -10), t20: fit(-5, -25), t30: fit(-5, -35), curve: Array.from({ length: Math.ceil(curve.length / stride) }, (_, i) => ({ seconds: (start + i * stride) / sr, db: Number.isFinite(curve[i * stride]) ? curve[i * stride] : null })) };
}
export function characterize(directory: string, output: string, raw: unknown) {
  directory = expand(directory); output = expand(output);
  const o = fields(raw, ['case_ids', 'measurements', 'channel', 'window_seconds', 'window_ms', 'harmonics', 'echo_threshold_db', 'echo_spacing_ms'], 'characterization');
  const state = load<State>(join(directory, 'run.json')), ids = o.case_ids ?? state.cases.map(c => c.id), modes = o.measurements ?? ['dynamics'];
  if (!Array.isArray(ids) || !ids.length || ids.length > 16 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string')) throw new Error('case_ids requires 1..16 distinct IDs');
  if (!Array.isArray(modes) || !modes.length || modes.some(m => !['dynamics', 'distortion', 'decay', 'echo', 'modulation'].includes(m)) || new Set(modes).size !== modes.length) throw new Error('Select distinct dynamics, distortion, decay, echo and/or modulation measurements');
  const channel = integer(o.channel ?? 0, 'channel', 0, 1), harmonics = integer(o.harmonics ?? 10, 'harmonics', 2, 32);
  const cases = ids.map(id => {
    const a = archive(directory, id); if (channel >= a.output.length) throw new Error('Requested channel is absent');
    const seconds = a.output[0].length / a.sr, range = o.window_seconds ?? [0, seconds];
    if (!Array.isArray(range) || range.length !== 2) throw new Error('window_seconds requires [start,end]');
    const start = Math.round(number(range[0], 'window start', 0, seconds) * a.sr), end = Math.round(number(range[1], 'window end', 0, seconds) * a.sr);
    if (end - start < 32) throw new Error('Window requires >=32 samples');
    const x = a.input[channel].subarray(start, end), y = a.output[channel].subarray(start, end), warnings: string[] = [];
    let dynamics = null, distortion = null, decay = null, echo = null, modulation = null;
    if (modes.includes('dynamics')) {
      const windowMs = number(o.window_ms ?? Math.max(20, (end - start) / a.sr * 1000 / 512), 'window_ms', 1, 2000), n = Math.max(1, Math.round(windowMs * a.sr / 1000));
      if (Math.ceil(x.length / n) > 1024) throw new Error('Dynamics envelope exceeds 1024 windows; increase window_ms');
      const envelope = [];
      for (let i = 0; i < x.length; i += n) {
        const stop = Math.min(x.length, i + n); let px = 0, py = 0;
        for (let k = i; k < stop; k++) { px += x[k] ** 2; py += y[k] ** 2; }
        envelope.push({ seconds: (start + (i + stop) / 2) / a.sr, input_rms_dbfs: db(Math.sqrt(px / (stop - i))), output_rms_dbfs: db(Math.sqrt(py / (stop - i))), gain_db: px > (stop - i) * 1e-16 ? db(Math.sqrt(py / px)) : null });
      }
      dynamics = { actual_window_ms: n / a.sr * 1000, envelope };
      warnings.push('RMS gain trajectories are descriptive, not attack/release time constants. No delay compensation; gain is null below -160 dBFS input. Use a continuing probe and explicit steady-state/transition windows for recovery tests.');
    }
    if (modes.includes('distortion')) {
      const s = a.stimulus, tones = s.kind === 'tone' || s.kind === undefined ? [{ frequency_hz: s.frequency_hz ?? 1000 }] : s.kind === 'multitone' ? (s.tones ?? []).filter(t => t.channel === undefined || t.channel === channel) : [];
      if (tones.length !== 1 && tones.length !== 2) throw new Error('Distortion requires a continuous tone or two-tone multitone in the selected channel');
      const hz = tones.map(t => t.frequency_hz);
      if (new Set(hz).size !== hz.length) throw new Error('Distortion requires distinct fundamental frequencies');
      if (tones.some(t => ('on_seconds' in t && t.on_seconds !== undefined && t.on_seconds > start / a.sr) || ('off_seconds' in t && t.off_seconds !== undefined && t.off_seconds < end / a.sr)) || hz.some(f => Math.abs(f * y.length / a.sr - Math.round(f * y.length / a.sr)) > 1e-6)) throw new Error('Distortion requires ungated, coherent integer-cycle tones in the selected window; choose window_seconds explicitly');
      const fundamentals = hz.map(f => ({ hz: f, input_peak_dbfs: db(amplitude(x, a.sr, f)), output_peak_dbfs: db(amplitude(y, a.sr, f)) })), denominator = hz.reduce((sum, f) => sum + amplitude(y, a.sr, f) ** 2, 0);
      const frequencies = hz.length === 1 ? Array.from({ length: harmonics - 1 }, (_, i) => hz[0] * (i + 2)) : [Math.abs(hz[1] - hz[0]), hz[0] + hz[1], Math.abs(2 * hz[0] - hz[1]), Math.abs(2 * hz[1] - hz[0]), 2 * hz[0] + hz[1], 2 * hz[1] + hz[0]];
      const unique = [...new Set(frequencies)].filter(f => f > 0 && f < a.sr / 2 && !hz.includes(f));
      if (!unique.length || denominator < 1e-20 || hz.some(f => amplitude(x, a.sr, f) < 1e-8)) throw new Error('Distortion requires excited input/output fundamentals and available product bins');
      const products = unique.map(f => ({ hz: f, input_peak_dbfs: db(amplitude(x, a.sr, f)), output_peak_dbfs: db(amplitude(y, a.sr, f)) })), power = unique.reduce((sum, f) => sum + amplitude(y, a.sr, f) ** 2, 0);
      distortion = { kind: hz.length === 1 ? 'thd' : 'selected_second_third_order_imd', fundamentals, products, ratio_db: db(Math.sqrt(power / denominator)), ratio_percent: 100 * Math.sqrt(power / denominator) };
      warnings.push('Coherent rectangular-window projections; includes input distortion and transients. THD excludes noise and aliased harmonics; IMD is the listed product energy / combined fundamental energy, not a standardized SMPTE/CCIF result. Inspect input products and steady-state windows.');
    }
    if (modes.includes('decay')) {
      if (a.stimulus.kind !== 'impulse') throw new Error('Decay estimation requires an archived impulse stimulus');
      let peak = 0; for (let i = 1; i < a.input[channel].length; i++) if (Math.abs(a.input[channel][i]) > Math.abs(a.input[channel][peak])) peak = i;
      if (start > peak) throw new Error('Decay window must include the input impulse');
      decay = decayCurve(a.output[channel].subarray(0, end), a.sr, peak);
      warnings.push('Schroeder reverse integration and linear decay fits, no noise-floor compensation. Truncated/noisy/multi-slope tails can bias extrapolated RT60; inspect R², fitted ranges and the full curve. An impulse through a static gain has no meaningful decay.');
    }
    if (modes.includes('echo')) {
      if (a.stimulus.kind !== 'impulse') throw new Error('Echo measurement requires an archived impulse stimulus');
      let peak = 0; for (let i = 1; i < a.input[channel].length; i++) if (Math.abs(a.input[channel][i]) > Math.abs(a.input[channel][peak])) peak = i;
      if (peak < start || peak >= end || Math.abs(a.input[channel][peak]) < 1e-12) throw new Error('Echo window must include an excited input impulse');
      echo = echoResponse(a.output[channel].subarray(0, end), a.sr, peak, Math.abs(a.input[channel][peak]), number(o.echo_threshold_db ?? -40, 'echo_threshold_db', -120, 0), number(o.echo_spacing_ms ?? 1, 'echo_spacing_ms', 0.01, 2000));
      warnings.push('Echo peaks are thresholded local maxima, not inferred delay lines or reverb topology. Up to 64 peaks; threshold is relative to the output peak. Timing includes host latency, dry path and filtering. Energy statistics use only the recorded post-impulse window; noise/truncated tails bias them. A silent response is null.');
    }
    if (modes.includes('modulation')) {
      if ((a.stimulus.kind ?? 'tone') !== 'tone') throw new Error('Modulation measurement requires a continuous tone stimulus');
      modulation = modulationTrace(x, y, a.sr, a.stimulus.frequency_hz ?? 1000, start, number(o.window_ms ?? 20, 'window_ms', 1, 2000));
      warnings.push('Windowed carrier gain and wrapped relative phase describe amplitude/phase modulation, not LFO rate/depth or a unique chorus/flanger/phaser model. Use settled continuous tones, several carrier frequencies and multiple modulation cycles. No latency compensation; null phase below -160 dBFS. Intra-window modulation is averaged and incomplete final windows are discarded.');
    }
    return { id, channel, window_seconds: [start / a.sr, end / a.sr], dynamics, distortion, decay, echo, modulation, warnings };
  });
  mkdirSync(dirname(output), { recursive: true }); mkdirSync(output);
  const report = join(output, 'characterization.json'); dump(report, { status: 'ok', reference_run_sha256: sha(join(directory, 'run.json')), identity: state.identity, options: o, cases });
  return { status: 'ok', directory: output, report, cases: cases.map(c => ({ id: c.id, distortion_ratio_db: c.distortion?.ratio_db ?? null, t20_rt60_seconds: c.decay?.t20?.extrapolated_rt60_seconds ?? null, warnings: c.warnings })) };
}

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { aligned, archive } from './compare.js';
import { dump, expand, fields, integer, load, number, sha } from './io.js';
import { db } from './measure.js';
import { eqResponse, type EqPoint } from './eq.js';
import type { Samples, State } from './types.js';

export const effectKinds = ['eq', 'filter', 'compressor', 'limiter', 'saturation', 'delay', 'reverb', 'phaser', 'flanger', 'chorus', 'tremolo'] as const;
export type EffectKind = typeof effectKinds[number];
export interface TransferPoint { input_db: number; output_db: number }
export interface SamplePair { x: number; y: number }
export interface CarrierPoint { seconds: number; gain: number; phase_degrees: number }
export type EffectObservation =
  | { kind: 'eq'; sample_rate: number; points: EqPoint[] }
  | { kind: 'dynamics'; points: TransferPoint[] }
  | { kind: 'saturation'; pairs: SamplePair[] }
  | { kind: 'delay' | 'reverb'; sample_rate: number; response: Float64Array }
  | { kind: 'modulation'; carrier_hz: number; points: CarrierPoint[] };

// EQ and filters share the existing impulse/noise + RBJ workflow.
export function effectResponse(directory: string, id: string, effect: EffectKind, channel = 0, lag = 0, settleSeconds = .25, windowMs = 20, frequencies?: number[]): EffectObservation {
  if (!effectKinds.includes(effect)) throw new Error('Unsupported effect kind');
  if (effect === 'eq' || effect === 'filter') { const measured = eqResponse(directory, id, channel, frequencies, lag); return { kind: 'eq', sample_rate: measured.source.sr, points: measured.points }; }
  const source = archive(directory, id);
  integer(channel, 'channel', 0, source.input.length - 1); integer(lag, 'lag_samples', -4000000, 4000000);
  number(settleSeconds, 'settle_seconds', 0, 20); number(windowMs, 'window_ms', 1, 2000);
  const item = source.state.spec.cases.find(c => c.id === id)!;
  if ((item.automation ?? source.state.spec.automation)?.length) throw new Error('Effect identification requires fixed controls, not automation');
  const [inputs, outputs] = aligned(source.input, source.output, lag), x = inputs[channel], y = outputs[channel], sr = source.sr, s = source.stimulus;
  if (effect === 'delay' || effect === 'reverb') {
    if (s.kind !== 'impulse') throw new Error('Delay/reverb identification requires an impulse');
    const at = x.findIndex(v => v !== 0);
    if (at < 0 || x.subarray(at + 1).some(v => v !== 0)) throw new Error('Exactly one excited impulse required after alignment');
    return { kind: effect, sample_rate: sr, response: Float64Array.from(y.subarray(at), v => v / x[at]) };
  }
  if ((s.kind ?? 'tone') !== 'tone') throw new Error('Dynamics, saturation and modulation identification require continuous tones');
  const start = Math.max(Math.round(settleSeconds * sr), effect === 'compressor' || effect === 'limiter' ? Math.floor(x.length * .75) : 0);
  if (x.length - start < 32) throw new Error('Insufficient audio after settling');
  const xx = x.subarray(start), yy = y.subarray(start), hz = s.frequency_hz ?? 1000;
  if (effect === 'compressor' || effect === 'limiter') {
    let px = 0, py = 0;
    for (let i = 0; i < xx.length; i++) { px = Math.max(px, Math.abs(xx[i])); py = Math.max(py, Math.abs(yy[i])); }
    if (px < 1e-8 || py < 1e-8) throw new Error('Static dynamics requires excited steady input/output');
    return { kind: 'dynamics', points: [{ input_db: db(px)!, output_db: db(py)! }] };
  }
  if (effect === 'saturation') {
    const count = Math.min(2048, xx.length);
    return { kind: 'saturation', pairs: Array.from({ length: count }, (_, i) => { const k = Math.floor(i * xx.length / count); return { x: xx[k], y: yy[k] }; }) };
  }
  const trace = modulationTrace(xx, yy, sr, hz, start, windowMs);
  return { kind: 'modulation', carrier_hz: hz, points: trace.envelope.filter(p => p.gain_db !== null && p.phase_degrees !== null).map(p => ({ seconds: p.seconds, gain: 10 ** (p.gain_db! / 20), phase_degrees: p.phase_degrees! })) };
}

export function observationSummary(observation: EffectObservation) {
  if (observation.kind === 'delay' || observation.kind === 'reverb') return { kind: observation.kind, sample_rate: observation.sample_rate, samples: observation.response.length, echo: echoResponse(observation.response, observation.sample_rate, 0, 1, -60, 1) };
  return observation;
}
export function characterizeEffects(directory: string, output: string, raw: unknown) {
  directory = expand(directory); output = expand(output);
  const o = fields(raw, ['effect', 'case_ids', 'channel', 'lag_samples', 'settle_seconds', 'window_ms', 'frequencies_hz'], 'effect measurements');
  if (typeof o.effect !== 'string' || !(effectKinds as readonly string[]).includes(o.effect)) throw new Error('Select a supported effect');
  const effect = o.effect as EffectKind;
  const kinds = effect === 'eq' || effect === 'filter' ? ['impulse', 'noise'] : effect === 'delay' || effect === 'reverb' ? ['impulse'] : ['tone'];
  const state = load<State>(join(directory, 'run.json')), ids = o.case_ids ?? state.spec.cases.filter(c => kinds.includes(c.stimulus.kind ?? 'tone')).map(c => c.id);
  if (!Array.isArray(ids) || !ids.length || ids.length > 16 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string')) throw new Error('Select 1..16 distinct case IDs');
  const channel = integer(o.channel ?? 0, 'channel', 0, 1), lag = integer(o.lag_samples ?? 0, 'lag_samples', -4000000, 4000000), settle = number(o.settle_seconds ?? .25, 'settle_seconds', 0, 20), window = number(o.window_ms ?? 20, 'window_ms', 1, 2000);
  if (o.frequencies_hz !== undefined && (effect !== 'eq' && effect !== 'filter' || !Array.isArray(o.frequencies_hz))) throw new Error('frequencies_hz is an array for EQ/filter only');
  const cases = ids.map(id => ({ id, observation: observationSummary(effectResponse(directory, id, effect, channel, lag, settle, window, o.frequencies_hz as number[] | undefined)) }));
  mkdirSync(dirname(output), { recursive: true }); mkdirSync(output); const report = join(output, 'effects.json');
  dump(report, { status: 'ok', effect, reference_run_sha256: sha(join(directory, 'run.json')), identity: state.identity, options: o, cases, limits: ['Fixed controls, explicit integer lag only. No inferred topology or timing compensation. Static dynamics uses settled peaks, saturation uses <=2048 aligned pairs per case, carrier trajectories require integer-cycle windows. Impulse timing/energy uses only the recorded tail. Use effects-identify for tested surrogate models.'] });
  return { status: 'ok', effect, directory: output, report, cases: cases.length };
}

// Timing is relative to the input impulse, not host latency compensation.
export function echoResponse(samples: Samples, sr: number, impulse: number, inputPeak: number, thresholdDb: number, spacingMs: number) {
  let peak = 0, peakIndex = impulse, energy = 0, moment = 0;
  for (let i = impulse; i < samples.length; i++) {
    const value = Math.abs(samples[i]), power = value * value;
    if (value > peak) { peak = value; peakIndex = i; }
    energy += power; moment += power * (i - impulse) / sr;
  }
  if (peak < 1e-12 || inputPeak < 1e-12) return null;
  const threshold = peak * 10 ** (thresholdDb / 20), spacing = Math.max(1, Math.round(spacingMs * sr / 1000)), centroid = moment / energy;
  const taps: { delay_samples: number; delay_seconds: number; gain_db: number | null }[] = [];
  let onset = -1, last = -spacing, lastValue = 0, count = 0, cumulative = 0, energy99 = -1, variance = 0, afterPeak = 0;
  for (let i = impulse; i < samples.length; i++) {
    const value = Math.abs(samples[i]), power = value * value, time = (i - impulse) / sr;
    cumulative += power; variance += power * (time - centroid) ** 2;
    if (i > peakIndex) afterPeak += power;
    if (energy99 < 0 && cumulative >= energy * 0.99) energy99 = i;
    if (onset < 0 && value >= threshold) onset = i;
    if (value < threshold || (i > impulse && value < Math.abs(samples[i - 1])) || (i + 1 < samples.length && value <= Math.abs(samples[i + 1]))) continue;
    const tap = { delay_samples: i - impulse, delay_seconds: time, gain_db: db(value / inputPeak) };
    if (i - last < spacing) {
      if (value > lastValue) { if (count <= 64) taps[taps.length - 1] = tap; last = i; lastValue = value; }
    } else {
      count++; if (taps.length < 64) taps.push(tap); last = i; lastValue = value;
    }
  }
  return { threshold_relative_db: thresholdDb, min_spacing_ms: spacing / sr * 1000, onset_delay_samples: onset - impulse, peak_delay_samples: peakIndex - impulse, energy_centroid_seconds: centroid, energy_spread_seconds: Math.sqrt(variance / energy), energy_99_seconds: (energy99 - impulse) / sr, energy_after_peak_fraction: afterPeak / energy, detected_peaks: count, taps_truncated: count > 64, taps };
}

export function modulationTrace(x: Samples, y: Samples, sr: number, hz: number, start: number, windowMs: number) {
  const n = Math.max(1, Math.round(windowMs * sr / 1000)), cycles = hz * n / sr;
  if (cycles < 2 || Math.abs(cycles - Math.round(cycles)) > 1e-6) throw new Error('Modulation requires >=2 integer carrier cycles per window; adjust window_ms or tone frequency');
  const windows = Math.floor(x.length / n);
  if (windows < 2 || windows > 1024) throw new Error('Modulation requires 2..1024 complete windows; adjust window_ms or window_seconds');
  const envelope = [];
  for (let offset = 0; offset + n <= x.length; offset += n) {
    let xr = 0, xi = 0, yr = 0, yi = 0;
    for (let i = 0; i < n; i++) {
      const angle = 2 * Math.PI * hz * i / sr, c = Math.cos(angle), s = -Math.sin(angle);
      xr += x[offset + i] * c; xi += x[offset + i] * s; yr += y[offset + i] * c; yi += y[offset + i] * s;
    }
    const input = 2 * Math.hypot(xr, xi) / n, output = 2 * Math.hypot(yr, yi) / n, excited = input > 1e-8;
    envelope.push({ seconds: (start + offset + n / 2) / sr, input_carrier_dbfs: db(input), output_carrier_dbfs: db(output), gain_db: excited ? db(output / input) : null, phase_degrees: excited && output > 1e-8 ? Math.atan2(yi * xr - yr * xi, yr * xr + yi * xi) * 180 / Math.PI : null });
  }
  return { carrier_hz: hz, actual_window_ms: n / sr * 1000, discarded_samples: x.length % n, envelope };
}

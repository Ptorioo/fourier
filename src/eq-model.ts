import type { EqPoint } from './eq.js';
import { bandRoots } from './filter-design.js';

export const eqFamilies = ['bell', 'low_shelf', 'high_shelf', 'low_pass', 'high_pass', 'notch', 'band_pass'] as const;
export type EqFamily = typeof eqFamilies[number];
export const eqTopologies = ['identical', 'butterworth'] as const;
export type EqTopology = typeof eqTopologies[number];
export interface EqModel { family: EqFamily | 'flat'; stages: number; frequency_hz: number; q: number; gain_db: number; topology?: EqTopology; bandpass_gain?: 'peak' | 'skirt' }
// RBJ cookbook families. Shelves use Q, not shelf slope S; cascades repeat identical sections.
export function eqCoefficients(model: EqModel, rate: number): number[] {
  const w = 2 * Math.PI * model.frequency_hz / rate, c = Math.cos(w), alpha = Math.sin(w) / (2 * model.q), a = 10 ** (model.gain_db / 40), beta = 2 * Math.sqrt(a) * alpha;
  let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
  switch (model.family) {
    case 'bell': b0 = 1 + alpha * a; b1 = -2 * c; b2 = 1 - alpha * a; a0 = 1 + alpha / a; a1 = -2 * c; a2 = 1 - alpha / a; break;
    case 'low_shelf': b0 = a * (a + 1 - (a - 1) * c + beta); b1 = 2 * a * (a - 1 - (a + 1) * c); b2 = a * (a + 1 - (a - 1) * c - beta); a0 = a + 1 + (a - 1) * c + beta; a1 = -2 * (a - 1 + (a + 1) * c); a2 = a + 1 + (a - 1) * c - beta; break;
    case 'high_shelf': b0 = a * (a + 1 + (a - 1) * c + beta); b1 = -2 * a * (a - 1 + (a + 1) * c); b2 = a * (a + 1 + (a - 1) * c - beta); a0 = a + 1 - (a - 1) * c + beta; a1 = 2 * (a - 1 - (a + 1) * c); a2 = a + 1 - (a - 1) * c - beta; break;
    case 'low_pass': b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha; break;
    case 'high_pass': b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha; break;
    case 'notch': b0 = 1; b1 = -2 * c; b2 = 1; a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha; break;
    case 'band_pass': b0 = model.bandpass_gain === 'skirt' ? Math.sin(w) / 2 : alpha; b1 = 0; b2 = -b0; a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha; break;
    case 'flat': b0 = 10 ** (model.gain_db / 20); break;
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}
export function eqSections(model: EqModel, rate: number): number[][] {
  if (!Number.isInteger(model.stages) || model.stages < 1 || model.stages > 8 || !Number.isFinite(model.frequency_hz) || model.frequency_hz <= 0 || model.frequency_hz >= rate / 2 || !Number.isFinite(model.q) || model.q <= 0 || !Number.isFinite(model.gain_db)) throw new Error('Invalid bounded EQ model');
  if (model.family === 'flat') return [eqCoefficients(model, rate)];
  if ((model.topology ?? 'identical') === 'identical') return Array.from({ length: model.stages }, () => eqCoefficients(model, rate));
  if (model.stages > 1 && ['notch', 'bell'].includes(model.family)) {
    const A = model.family === 'bell' ? 10 ** (model.gain_db / 40) : 1, poles = bandRoots(model.stages, 1 / (model.q * A)), zeros = bandRoots(model.stages, A / model.q), k = Math.tan(Math.PI * model.frequency_hz / rate), k2 = k * k;
    return poles.map((p, i) => {
      const z = model.family === 'notch' ? [0, 1] : zeros[i], scale = p[1] / z[1], d = 1 + p[0] * k + p[1] * k2;
      return [scale * (1 + z[0] * k + z[1] * k2) / d, scale * 2 * (z[1] * k2 - 1) / d, scale * (1 - z[0] * k + z[1] * k2) / d, 2 * (p[1] * k2 - 1) / d, (1 - p[0] * k + p[1] * k2) / d];
    });
  }
  return Array.from({ length: model.stages }, (_, i) => {
    let q = 1 / (2 * Math.cos(Math.PI * (2 * i + 1) / (4 * model.stages)));
    if (i === model.stages - 1) q *= model.q / Math.SQRT1_2;
    return eqCoefficients({ ...model, q }, rate);
  });
}
const wrap = (degrees: number) => ((degrees + 180) % 360 + 360) % 360 - 180;
function at(coefficients: number[], stages: number, c: number, s: number) {
  const [b0, b1, b2, a1, a2] = coefficients, c2 = 2 * c * c - 1, s2 = 2 * s * c;
  const nr = b0 + b1 * c + b2 * c2, ni = -b1 * s - b2 * s2, dr = 1 + a1 * c + a2 * c2, di = -a1 * s - a2 * s2;
  return { gain_db: stages * 10 * Math.log10(Math.max(1e-24, (nr * nr + ni * ni) / (dr * dr + di * di))), phase_degrees: wrap(stages * (Math.atan2(ni, nr) - Math.atan2(di, dr)) * 180 / Math.PI) };
}
export function modelPoint(model: EqModel, rate: number, frequency: number) {
  const w = 2 * Math.PI * frequency / rate;
  const points = eqSections(model, rate).map(c => at(c, 1, Math.cos(w), Math.sin(w)));
  return { gain_db: points.reduce((s, p) => s + p.gain_db, 0), phase_degrees: wrap(points.reduce((s, p) => s + p.phase_degrees, 0)) };
}
export function fitEq(points: EqPoint[], rate: number, families: readonly EqFamily[] = eqFamilies, stages = [1, 2], topologies: readonly EqTopology[] = eqTopologies) {
  const usable = points.filter(p => p.gain_db !== null && p.phase_degrees !== null && (p.coherence === null || p.coherence >= .95));
  if (usable.length < 24) throw new Error('EQ identification needs at least 24 excited, coherent magnitude/phase points');
  const data = usable.map((p, i) => ({ ...p, c: Math.cos(2 * Math.PI * p.bin_hz / rate), s: Math.sin(2 * Math.PI * p.bin_hz / rate), held_out: i % 4 === 0 }));
  const score = (model: EqModel, held: boolean) => {
    const sections = eqSections(model, rate); let magnitude = 0, phase = 0, maximum = 0, n = 0;
    for (const p of data) if (p.held_out === held) {
      const response = sections.map(c => at(c, 1, p.c, p.s)), predicted = { gain_db: response.reduce((s, r) => s + r.gain_db, 0), phase_degrees: wrap(response.reduce((s, r) => s + r.phase_degrees, 0)) }, error = predicted.gain_db - p.gain_db!;
      magnitude += error * error; phase += wrap(predicted.phase_degrees - p.phase_degrees!) ** 2; maximum = Math.max(maximum, Math.abs(error)); n++;
    }
    return { magnitude_rmse_db: Math.sqrt(magnitude / n), magnitude_max_error_db: maximum, phase_rmse_degrees: Math.sqrt(phase / n), cost: (magnitude + phase / 400) / n };
  };
  const average = data.filter(p => !p.held_out).reduce((sum, p) => sum + p.gain_db!, 0) / data.filter(p => !p.held_out).length;
  const flat: EqModel = { family: 'flat', stages: 1, frequency_hz: 1000, q: 1, gain_db: average };
  const results = [{ model: flat, training: score(flat, false), held_out: score(flat, true) }];
  const low = Math.log(20), high = Math.log(Math.min(20000, rate * .45));
  const peak = data.reduce((a, b) => Math.abs(a.gain_db!) > Math.abs(b.gain_db!) ? a : b), passPeak = data.reduce((a, b) => a.gain_db! > b.gain_db! ? a : b);
  let slopeIndex = 1;
  for (let i = 2; i < data.length; i++) if (Math.abs(data[i].gain_db! - data[i - 1].gain_db!) > Math.abs(data[slopeIndex].gain_db! - data[slopeIndex - 1].gain_db!)) slopeIndex = i;
  const slope = data[slopeIndex];
  for (const family of families) for (const count of stages) for (const topology of topologies) for (const bandpass_gain of (family === 'band_pass' ? ['peak', 'skirt'] as const : ['peak'] as const)) {
    if (count === 1 && topology === 'butterworth' && topologies.includes('identical')) continue;
    const gainFamily = ['bell', 'low_shelf', 'high_shelf'].includes(family);
    let best: ReturnType<typeof results.at>;
    for (const seedQ of [.7, 3]) {
      let v = [Math.log(family === 'band_pass' ? passPeak.bin_hz : family === 'bell' || family === 'notch' ? peak.bin_hz : slope.bin_hz), Math.log(seedQ), Math.max(-36, Math.min(36, peak.gain_db! / count))];
      const model = (x: number[]): EqModel => ({ family, stages: count, frequency_hz: Math.exp(x[0]), q: Math.exp(x[1]), gain_db: gainFamily ? x[2] : 0, topology, ...(family === 'band_pass' ? { bandpass_gain } : {}) });
      let value = score(model(v), false).cost, step = [(high - low) / 5, 1, 6];
      for (let cycle = 0; cycle < 75; cycle++) {
        let improved = false;
        for (let dimension = 0; dimension < (gainFamily ? 3 : 2); dimension++) for (const sign of [-1, 1]) {
          const next = [...v]; next[dimension] += sign * step[dimension];
          next[0] = Math.max(low, Math.min(high, next[0])); next[1] = Math.max(Math.log(.1), Math.min(Math.log(18), next[1])); next[2] = Math.max(-36, Math.min(36, next[2]));
          const cost = score(model(next), false).cost;
          if (cost < value) { v = next; value = cost; improved = true; }
        }
        if (!improved) step = step.map(s => s * .6);
        if (step[0] < 1e-5 && step[1] < 1e-5 && step[2] < 1e-4) break;
      }
      const fitted = model(v), item = { model: fitted, training: score(fitted, false), held_out: score(fitted, true) };
      if (!best || item.training.cost < best.training.cost) best = item;
    }
    results.push(best!);
  }
  results.sort((a, b) => a.training.cost - b.training.cost);
  const best = results[0], accepted = best.held_out.magnitude_rmse_db <= .25 && best.held_out.phase_rmse_degrees <= 3;
  const alternatives = results.filter(r => r.training.cost <= best.training.cost + .01);
  return { best, accepted, ambiguous: alternatives.length > 1 || best.model.family === 'flat', alternatives: alternatives.map(r => r.model), candidates: results, held_out_frequency_count: data.filter(p => p.held_out).length, limits: 'Bounded multi-start surrogate fit; families include up to eight identical RBJ sections, resonance-scaled Butterworth SOS cascades and Butterworth band-transformed notch/bell sections; band-pass tests peak/skirt normalization. Other topologies, nonlinearity and time variation may not fit. Held-out frequencies validate interpolation, not a separate render. Equivalent fits do not establish original internals.' };
}

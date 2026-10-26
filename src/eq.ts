import { aligned, archive, response } from './compare.js';
import { expand, integer, number } from './io.js';
import { spectrum } from './measure.js';

export const eqFrequencies = (rate: number, count = 128) => Array.from({ length: count }, (_, i) => 20 * (Math.min(20000, rate * .45) / 20) ** (i / (count - 1)));
export interface EqPoint { requested_hz: number; bin_hz: number; gain_db: number | null; phase_degrees: number | null; coherence: number | null }
export function eqResponse(directory: string, id: string, channel = 0, frequencies?: number[], lag = 0): { points: EqPoint[]; source: ReturnType<typeof archive> } {
  const source = archive(expand(directory), id), { sr, stimulus, state } = source;
  integer(channel, 'channel', 0, source.input.length - 1);
  const item = state.spec.cases.find(c => c.id === id)!;
  if ((item.automation ?? state.spec.automation)?.length) throw new Error('EQ response requires time-invariant settings, not automation');
  const hz = frequencies ?? eqFrequencies(sr);
  if (!hz.length || hz.length > 256) throw new Error('Select 1..256 frequencies');
  hz.forEach(f => number(f, 'frequency_hz', 1, sr * .49));
  const [input, output] = aligned(source.input, source.output, lag), x = input[channel], y = output[channel];
  let points: EqPoint[];
  if (stimulus.kind === 'impulse') {
    let count = 0; for (const v of x) if (v !== 0) count++;
    if (count !== 1) throw new Error('Impulse response requires exactly one nonzero input sample after explicit alignment');
    const n = 2 ** Math.ceil(Math.log2(x.length));
    if (n > 2 ** 23) throw new Error('Impulse FFT exceeds analysis budget');
    const xx = new Float64Array(n), yy = new Float64Array(n); xx.set(x); yy.set(y);
    const [xr, xi] = spectrum(xx), [yr, yi] = spectrum(yy);
    points = hz.map(f => {
      const k = Math.max(1, Math.min(n / 2 - 1, Math.round(f * n / sr))), denominator = xr[k] ** 2 + xi[k] ** 2;
      const re = (yr[k] * xr[k] + yi[k] * xi[k]) / denominator, im = (yi[k] * xr[k] - yr[k] * xi[k]) / denominator, gain = Math.hypot(re, im);
      return { requested_hz: f, bin_hz: k * sr / n, gain_db: gain > 1e-15 ? 20 * Math.log10(gain) : null, phase_degrees: gain > 1e-15 ? Math.atan2(im, re) * 180 / Math.PI : null, coherence: null };
    });
  } else if (stimulus.kind === 'noise') {
    const start = Math.floor(x.length / 4);
    points = response(x.subarray(start), y.subarray(start), sr, hz).map(p => ({ requested_hz: p.requested_hz, bin_hz: p.bin_hz, gain_db: p.h1_gain_db, phase_degrees: p.h1_phase_degrees, coherence: p.coherence }));
  } else throw new Error('EQ response requires an impulse or continuous noise case');
  return { points, source };
}

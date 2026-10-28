import { number } from './io.js';
import { db, stats } from './measure.js';
import type { Audio } from './types.js';
export interface ErrorOptions { window_seconds?: [number, number]; reference_floor_dbfs?: number }

export function aligned(x: Audio, y: Audio, lag: number): [Audio, Audio] {
  if (!Number.isInteger(lag) || Math.abs(lag) >= Math.min(x[0].length, y[0].length) - 31) throw new Error('lag_samples must be an integer leaving >=32 aligned frames');
  const a = Math.max(0, -lag), b = Math.max(0, lag), n = Math.min(x[0].length - a, y[0].length - b);
  return [x.map(ch => ch.subarray(a, a + n)), y.map(ch => ch.subarray(b, b + n))];
}
// Windows use the reference's original clock, including for negative explicit lags.
export function analysisWindow(frames: number, sr: number, raw?: unknown, offset = 0) {
  if (raw !== undefined && (!Array.isArray(raw) || raw.length !== 2)) throw new Error('window_seconds requires [start, end]');
  const values = raw as number[] | undefined, start = values ? number(values[0], 'window start', 0, (offset + frames) / sr) : offset / sr;
  const end = values ? number(values[1], 'window end', 0, (offset + frames) / sr) : (offset + frames) / sr;
  const a = Math.round(start * sr) - offset, b = Math.round(end * sr) - offset;
  if (a < 0 || b > frames || b - a < 32) throw new Error('Analysis window requires >=32 frames inside explicit aligned overlap');
  return { a, b, seconds: [(a + offset) / sr, (b + offset) / sr] };
}
export function candidateError(reference: Audio, candidate: Audio, sr: number, lag = 0, window?: unknown, floorDbfs?: unknown) {
  if (reference.length !== candidate.length || reference.some((c, i) => c.length !== candidate[i].length)) throw new Error('Candidate/reference output shapes must match exactly');
  const [x, y] = aligned(reference, candidate, lag), w = analysisWindow(x[0].length, sr, window, Math.max(0, -lag));
  const floor = floorDbfs === undefined ? null : 10 ** (number(floorDbfs, 'reference_floor_dbfs', -300, 0) / 10);
  const a = x.map(ch => ch.subarray(w.a, w.b)), b = y.map(ch => ch.subarray(w.a, w.b));
  const difference = b.map((ch, c) => Float32Array.from(ch, (v, i) => v - a[c][i]));
  const channels = a.map((ch, c) => {
    let error = 0, power = 0, peak = 0;
    for (let i = 0; i < ch.length; i++) { const d = b[c][i] - ch[i]; error += d * d; power += ch[i] ** 2; peak = Math.max(peak, Math.abs(d)); }
    const denominator = floor === null ? power : Math.max(power, floor * ch.length), rms = Math.sqrt(error / ch.length);
    return { samples: ch.length, squared_error: error, reference_energy: power, exact_null: error === 0, rms_error: rms, peak_error: peak, rms_error_dbfs: db(rms), peak_error_dbfs: db(peak), relative_mse: denominator > 0 ? error / denominator : null, relative_error_db: denominator > 0 ? db(Math.sqrt(error / denominator)) : null, reference_floored: floor !== null && power < floor * ch.length };
  });
  return { window_seconds: w.seconds, lag_samples: lag, reference_floor_dbfs: floorDbfs ?? null, null_difference: stats(difference), channels };
}

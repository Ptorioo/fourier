import { fitEq } from './eq-model.js';
import type { CarrierPoint, EffectKind, EffectObservation, SamplePair, TransferPoint } from './effects.js';

export interface EffectFit {
  model: { family: string; [key: string]: number | string };
  accepted: boolean;
  ambiguous: boolean;
  training_error: number | null;
  held_out_error: number | null;
  error_metric: string;
  limits: string[];
  eq_diagnostics?: ReturnType<typeof fitEq>;
}
const clamp = (x: number, low: number, high: number) => Math.max(low, Math.min(high, x));
const rms = (values: number[]) => Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length);
function minimize(seed: number[], bounds: number[][], cost: (v: number[]) => number) {
  let v = [...seed], best = cost(v), steps = bounds.map(([a, b]) => (b - a) / 5);
  for (let cycle = 0; cycle < 120; cycle++) {
    let improved = false;
    for (let d = 0; d < v.length; d++) for (const sign of [-1, 1]) {
      const next = [...v]; next[d] = clamp(next[d] + sign * steps[d], bounds[d][0], bounds[d][1]);
      const value = cost(next);
      if (value < best) { v = next; best = value; improved = true; }
    }
    if (!improved) steps = steps.map(s => s * .6);
    if (steps.every(s => s < 1e-6)) break;
  }
  return v;
}
export function dynamicsPoint(input: number, threshold: number, slope: number, makeup: number, knee = 0) {
  const over = input - threshold;
  return input + makeup + (slope - 1) * (knee > 0 && Math.abs(over) < knee / 2 ? (over + knee / 2) ** 2 / (2 * knee) : Math.max(0, over));
}
export function fitDynamics(points: TransferPoint[], limiter = false): EffectFit {
  if (points.length < 8 || points.length > 256 || points.some(p => !Number.isFinite(p.input_db) || !Number.isFinite(p.output_db)) || new Set(points.map(p => p.input_db)).size < 8) throw new Error('Dynamics fitting requires 8..256 finite distinct input levels');
  const ordered = [...points].sort((a, b) => a.input_db - b.input_db), train = ordered.filter((_, i) => i % 4 !== 0), held = ordered.filter((_, i) => i % 4 === 0);
  let best: { v: number[]; error: number } | undefined;
  // Hard/soft-knee downward transfer only; no detector time constants are inferred from steady peaks.
  for (const threshold of [-48, -24, -6]) for (const slope of limiter ? [0] : [.1, .5]) {
    const bounds = [[-72, 0], limiter ? [0, 0] : [0, 1], [-36, 36], limiter ? [0, 0] : [0, 24]];
    const error = (v: number[], data = train) => rms(data.map(p => dynamicsPoint(p.input_db, v[0], v[1], v[2], v[3]) - p.output_db));
    const v = minimize([threshold, slope, 0, 0], bounds, error), value = error(v);
    if (!best || value < best.error) best = { v, error: value };
  }
  const [threshold, slope, makeup, knee] = best!.v, error = (data: TransferPoint[]) => rms(data.map(p => dynamicsPoint(p.input_db, threshold, slope, makeup, knee) - p.output_db));
  const ambiguous = slope > .99 || train.filter(p => p.input_db > threshold + knee / 2).length < 2 || train.filter(p => p.input_db < threshold - knee / 2).length < 2;
  return { model: { family: limiter ? 'static_peak_limiter' : 'static_soft_knee', threshold_db: threshold, slope_above: slope, ratio: slope > 1e-6 ? 1 / slope : 'infinite', makeup_db: makeup, knee_db: knee }, accepted: error(train) <= .5 && error(held) <= .5 && !ambiguous, ambiguous, training_error: error(train), held_out_error: error(held), error_metric: 'peak_transfer_rmse_db', limits: ['Steady peak-level transfer surrogate, not detector/attack/release/lookahead/linking recovery. Peaks can be biased by ripple, distortion or insufficient settling.', 'Every fourth sorted input level is held out. Threshold -72..0 dB, ratio 1..infinity, makeup ±36 dB, knee 0..24 dB. At least two training levels must excite each side of the knee.'] };
}
export function saturationPoint(x: number, family: string, drive: number) {
  const v = drive * x;
  if (family === 'tanh') return Math.tanh(v);
  if (family === 'hard_clip') return clamp(v, -1, 1);
  if (family === 'cubic_clip') { const t = clamp(v, -1, 1); return t - t ** 3 / 3; }
  return x;
}
export function fitSaturation(pairs: SamplePair[]): EffectFit {
  if (pairs.length < 64 || pairs.length > 16384 || pairs.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new Error('Saturation fitting requires 64..16384 finite aligned sample pairs');
  const train = pairs.filter((_, i) => i % 4 !== 0), held = pairs.filter((_, i) => i % 4 === 0);
  const energy = (data: SamplePair[]) => data.reduce((s, p) => s + p.y * p.y, 0);
  if (energy(train) < 1e-16 || energy(held) < 1e-16 || train.reduce((s, p) => s + p.x * p.x, 0) < 1e-16) throw new Error('Saturation fitting requires excited input and output');
  const evaluate = (family: string, logDrive: number) => {
    const drive = Math.exp(logDrive), power = train.reduce((s, p) => s + saturationPoint(p.x, family, drive) ** 2, 0);
    const gain = train.reduce((s, p) => s + p.y * saturationPoint(p.x, family, drive), 0) / Math.max(power, 1e-30);
    const error = (data: SamplePair[]) => Math.sqrt(data.reduce((s, p) => s + (gain * saturationPoint(p.x, family, drive) - p.y) ** 2, 0) / energy(data));
    return { family, drive, output_gain: gain, training: error(train), held: error(held) };
  };
  const candidates = ['linear', 'tanh', 'hard_clip', 'cubic_clip'].map(family => {
    let best = evaluate(family, 0);
    if (family !== 'linear') for (let i = 0; i <= 64; i++) { const item = evaluate(family, Math.log(.1) + Math.log(1000) * i / 64); if (item.training < best.training) best = item; }
    if (family !== 'linear') {
      const v = minimize([Math.log(best.drive)], [[Math.log(.1), Math.log(100)]], x => evaluate(family, x[0]).training); best = evaluate(family, v[0]);
    }
    return best;
  }).sort((a, b) => a.training - b.training);
  const best = candidates[0], ambiguous = best.family === 'linear' || candidates[1].training <= best.training + .005;
  return { model: { family: best.family, drive: best.drive, drive_db: 20 * Math.log10(best.drive), output_gain: best.output_gain }, accepted: best.training <= .02 && best.held <= .02, ambiguous, training_error: best.training, held_out_error: best.held, error_metric: 'relative_sample_rmse', limits: ['Memoryless symmetric linear/tanh/hard-clip/clipped-cubic + output gain only; drive 0.1..100. No wet/dry, asymmetry, bias, oversampling, hysteresis or filtering model.', 'Every fourth aligned sample pair held out; this is interpolation, not independent signal validation. Explicit lag is required for latent processors. Linear/near-equivalent fits do not identify a unique waveshaper.'] };
}
export function fitDelay(response: Float64Array, rate: number): EffectFit {
  if (response.length < 32 || !Number.isFinite(rate) || rate <= 0 || response.some(v => !Number.isFinite(v))) throw new Error('Delay fitting requires a finite impulse response and positive sample rate');
  const split = Math.floor(response.length * 2 / 3);
  let delay = 1; for (let i = 2; i < split; i++) if (Math.abs(response[i]) > Math.abs(response[delay])) delay = i;
  const wet = response[delay], dry = response[0]; let xy = 0, xx = 0;
  for (let i = 2 * delay; i < split; i += delay) { xy += response[i] * response[i - delay]; xx += response[i - delay] ** 2; }
  const feedback = xx > 1e-20 ? clamp(xy / xx, -.999, .999) : 0;
  const error = (a: number, b: number) => {
    let power = 0, residual = 0;
    for (let i = a; i < b; i++) { const predicted = i === 0 ? dry : i % delay === 0 ? wet * feedback ** (i / delay - 1) : 0; power += response[i] ** 2; residual += (response[i] - predicted) ** 2; }
    return power > 1e-20 ? Math.sqrt(residual / power) : null;
  };
  const training = error(0, split), held = error(split, response.length), ambiguous = Math.abs(wet) < 1e-8 || split < 3 * delay;
  return { model: { family: 'integer_feedback_delay', delay_samples: delay, delay_ms: delay / rate * 1000, dry_gain: dry, wet_gain: wet, feedback }, accepted: training !== null && training <= .02 && held !== null && held <= .05 && !ambiguous, ambiguous, training_error: training, held_out_error: held, error_metric: 'relative_impulse_rmse', limits: ['Single integer-sample delay + signed feedback and independent dry/wet gains; not fractional, filtered, ping-pong, multi-tap or modulated delay. Alignment must remove host latency explicitly.', 'Fit uses first two thirds, final third is held out. At least three repeats must fit the training window; silent held-out tails are unvalidated, not a perfect match. Strongest non-direct training sample seeds the delay; subharmonic alternatives are not exhaustively searched.'] };
}
export function fitReverb(response: Float64Array, rate: number): EffectFit {
  if (response.length < 32 || !Number.isFinite(rate) || rate <= 0 || response.some(v => !Number.isFinite(v))) throw new Error('Reverb fitting requires a finite impulse response and positive sample rate');
  const energy = new Float64Array(response.length); let total = 0;
  for (let i = response.length - 1; i >= 0; i--) { total += response[i] ** 2; energy[i] = total; }
  if (total < 1e-20) throw new Error('Reverb fitting requires an excited tail');
  const points: { x: number; y: number }[] = [];
  for (let i = 0, stride = Math.max(1, Math.ceil(response.length / 1024)); i < response.length; i += stride) {
    const y = 10 * Math.log10(energy[i] / total);
    if (y <= -5 && y >= -35) points.push({ x: i / rate, y });
  }
  if (points.length < 16 || Math.min(...points.map(p => p.y)) > -30 || Math.max(...points.map(p => p.y)) < -6) throw new Error('Reverb needs a resolved -5..-35 dB energy decay span; increase duration/excitation');
  const train = points.filter((_, i) => i % 4 !== 0), held = points.filter((_, i) => i % 4 === 0);
  const mx = train.reduce((s, p) => s + p.x, 0) / train.length, my = train.reduce((s, p) => s + p.y, 0) / train.length;
  const slope = train.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / train.reduce((s, p) => s + (p.x - mx) ** 2, 0), intercept = my - slope * mx;
  if (!Number.isFinite(slope) || slope >= 0) throw new Error('Reverb decay has no finite negative slope');
  const error = (data: typeof points) => rms(data.map(p => slope * p.x + intercept - p.y));
  return { model: { family: 'exponential_energy_decay', rt60_seconds: -60 / slope, slope_db_per_second: slope, intercept_db: intercept }, accepted: error(train) <= 1 && error(held) <= 1, ambiguous: true, training_error: error(train), held_out_error: error(held), error_metric: 'integrated_decay_rmse_db', limits: ['Schroeder -5..-35 dB straight-line energy-decay surrogate only. Always topology-ambiguous: RT60 cannot reconstruct a reverb, damping network, stereo diffusion, room size or predelay.', 'Every fourth sampled decay point held out, not an independent render; reverse integration couples points. No noise compensation; finite/truncated tails can bias RT60 and acceptance.'] };
}
// Solve the three normal equations for offset + cos + sin; singular fits are discarded.
function sinusoid(points: { t: number; y: number }[], hz: number) {
  const a = Array.from({ length: 3 }, () => [0, 0, 0, 0]);
  for (const p of points) { const v = [1, Math.cos(2 * Math.PI * hz * p.t), Math.sin(2 * Math.PI * hz * p.t)]; for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) a[i][j] += v[i] * v[j]; a[i][3] += v[i] * p.y; } }
  for (let i = 0; i < 3; i++) {
    let pivot = i; for (let j = i + 1; j < 3; j++) if (Math.abs(a[j][i]) > Math.abs(a[pivot][i])) pivot = j;
    [a[i], a[pivot]] = [a[pivot], a[i]];
    const divisor = a[i][i]; if (Math.abs(divisor) < 1e-12) return null;
    for (let k = i; k < 4; k++) a[i][k] /= divisor;
    for (let j = 0; j < 3; j++) if (j !== i) { const factor = a[j][i]; for (let k = i; k < 4; k++) a[j][k] -= factor * a[i][k]; }
  }
  return a.map(row => row[3]);
}
export function fitModulation(points: CarrierPoint[], rateBounds: [number, number] = [.2, 10]): EffectFit {
  const [low, high] = rateBounds;
  if (points.length < 32 || points.length > 1024 || points.some(p => !Number.isFinite(p.seconds) || !Number.isFinite(p.gain) || !Number.isFinite(p.phase_degrees) || p.gain <= 0) || points.some((p, i) => i > 0 && p.seconds <= points[i - 1].seconds)) throw new Error('Modulation fitting requires 32..1024 finite, time-ordered excited carrier points');
  const dt = Math.max(...points.slice(1).map((p, i) => p.seconds - points[i].seconds));
  if (!(low >= .01 && high > low && high <= 20 && high < .5 / dt)) throw new Error('rate_bounds_hz requires 0.01 <= low < high <= 20 below envelope Nyquist');
  let previous = points[0].phase_degrees;
  const rows = points.map((p, i) => { const phase = i === 0 ? previous : previous + ((p.phase_degrees - previous + 180) % 360 + 360) % 360 - 180; previous = phase; return { t: p.seconds, gain: p.gain, phase }; });
  const train = rows.filter((_, i) => i % 4 !== 0), held = rows.filter((_, i) => i % 4 === 0), span = points.at(-1)!.seconds - points[0].seconds;
  const gainScale = Math.max(.01, rms(train.map(p => p.gain))), phaseScale = 180;
  const predict = (v: number[], t: number, hz: number) => v[0] + v[1] * Math.cos(2 * Math.PI * hz * t) + v[2] * Math.sin(2 * Math.PI * hz * t);
  const at = (hz: number) => {
    const gain = sinusoid(train.map(p => ({ t: p.t, y: p.gain })), hz), phase = sinusoid(train.map(p => ({ t: p.t, y: p.phase })), hz);
    if (!gain || !phase) return null;
    const error = (data: typeof rows) => Math.sqrt(data.reduce((s, p) => s + ((predict(gain, p.t, hz) - p.gain) / gainScale) ** 2 + ((predict(phase, p.t, hz) - p.phase) / phaseScale) ** 2, 0) / data.length);
    return { hz, gain, phase, training: error(train), held: error(held) };
  };
  const steps = Math.max(256, Math.ceil((high - low) * span * 8));
  if (steps > 4096) throw new Error('Modulation search exceeds 4096 candidates; narrow rate_bounds_hz');
  let best: ReturnType<typeof at> = null;
  for (let i = 0; i <= steps; i++) { const item = at(low + (high - low) * i / steps); if (item && (!best || item.training < best.training)) best = item; }
  if (!best) throw new Error('Singular modulation fit');
  const width = (high - low) / steps, v = minimize([best.hz], [[Math.max(low, best.hz - width), Math.min(high, best.hz + width)]], x => at(x[0])?.training ?? Infinity);
  best = at(v[0])!;
  const gainAmplitude = Math.hypot(best.gain[1], best.gain[2]), phaseAmplitude = Math.hypot(best.phase[1], best.phase[2]), ambiguous = gainAmplitude < gainScale * .005 && phaseAmplitude < 1 || best.hz * span < 2;
  return { model: { family: 'sinusoidal_carrier_trajectory', rate_hz: best.hz, gain_offset: best.gain[0], gain_cos: best.gain[1], gain_sin: best.gain[2], phase_offset_degrees: best.phase[0], phase_cos_degrees: best.phase[1], phase_sin_degrees: best.phase[2] }, accepted: best.training <= .02 && best.held <= .02 && !ambiguous, ambiguous, training_error: best.training, held_out_error: best.held, error_metric: 'carrier_gain_relative_and_phase_over_180_rmse', limits: ['Single sinusoidal gain/phase trajectory at one carrier; useful for tremolo and modulation evidence, NOT a recovered phaser/flanger/chorus DSP topology. No inference of stages, delay depth, feedback or wet mix.', 'Every fourth window held out. Phase unwrapping assumes <180 degrees change between windows; intra-window changes are averaged. At least two fitted cycles and nonconstant modulation required; multi-rate/random/non-sine LFOs may fail.'] };
}
export function fitEffect(effect: EffectKind, observations: EffectObservation[], rateBounds?: [number, number]): EffectFit {
  if (!observations.length) throw new Error('Effect observations required');
  if (effect === 'compressor' || effect === 'limiter') {
    if (observations.some(o => o.kind !== 'dynamics')) throw new Error('Dynamics observations required');
    return fitDynamics(observations.flatMap(o => o.kind === 'dynamics' ? o.points : []), effect === 'limiter');
  }
  if (effect === 'saturation') {
    if (observations.some(o => o.kind !== 'saturation')) throw new Error('Saturation observations required');
    return fitSaturation(observations.flatMap(o => o.kind === 'saturation' ? o.pairs : []));
  }
  if (observations.length !== 1) throw new Error('Select one impulse or carrier observation per model fit');
  const observation = observations[0];
  if ((effect === 'eq' || effect === 'filter') && observation.kind === 'eq') {
    const fit = fitEq(observation.points, observation.sample_rate);
    return { model: { ...fit.best.model }, accepted: fit.accepted, ambiguous: fit.ambiguous, training_error: fit.best.training.magnitude_rmse_db, held_out_error: fit.best.held_out.magnitude_rmse_db, error_metric: 'magnitude_rmse_db (acceptance also checks phase)', limits: [fit.limits], eq_diagnostics: fit };
  }
  if (effect === 'delay' && observation.kind === 'delay') return fitDelay(observation.response, observation.sample_rate);
  if (effect === 'reverb' && observation.kind === 'reverb') return fitReverb(observation.response, observation.sample_rate);
  if (['phaser', 'flanger', 'chorus', 'tremolo'].includes(effect) && observation.kind === 'modulation') return fitModulation(observation.points, rateBounds);
  throw new Error('Effect and observation kinds do not match');
}

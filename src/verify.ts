import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { aligned, archive } from './compare.js';
import { eqResponse } from './eq.js';
import { dump, expand, fields, integer, number, sha } from './io.js';
import { amplitude, db, stats } from './measure.js';
import { analysisWindow, candidateError } from './audio-error.js';

export const verificationMetrics = ['tone_gain_db', 'peak_dbfs', 'rms_dbfs', 'dc', 'full_scale_fraction', 'reported_latency_samples', 'impulse_peak_lag_samples', 'eq_gain_db', 'eq_phase_degrees', 'candidate_relative_error_db', 'candidate_rms_error', 'candidate_peak_error', 'candidate_rms_error_dbfs', 'candidate_peak_error_dbfs'] as const;
export function verify(directory: string, output: string, raw: unknown) {
  directory = expand(directory); output = expand(output);
  const o = fields(raw, ['checks', 'candidate_run', 'lag_samples', 'candidate_lag_samples', 'window_seconds', 'reference_floor_dbfs'], 'verification option');
  if (!Array.isArray(o.checks) || !o.checks.length || o.checks.length > 128) throw new Error('Verification requires 1..128 checks');
  if (o.candidate_run !== undefined && typeof o.candidate_run !== 'string') throw new Error('candidate_run must be a path');
  const lag = integer(o.lag_samples ?? 0, 'lag_samples', -4000000, 4000000), candidateLag = integer(o.candidate_lag_samples ?? 0, 'candidate_lag_samples', -4000000, 4000000);
  if (o.candidate_lag_samples !== undefined && !o.candidate_run) throw new Error('candidate_lag_samples requires candidate_run');
  const rows = o.checks.map(rawCheck => {
    const c = fields(rawCheck, ['case_id', 'metric', 'channel', 'frequency_hz', 'min', 'max', 'window_seconds'], 'check');
    if (typeof c.case_id !== 'string' || !verificationMetrics.includes(c.metric as typeof verificationMetrics[number])) throw new Error('Check requires a case_id and a supported metric');
    if (c.min === undefined && c.max === undefined) throw new Error('Each check requires min and/or max');
    const min = c.min === undefined ? -Infinity : number(c.min, 'min', -1e12, 1e12), max = c.max === undefined ? Infinity : number(c.max, 'max', -1e12, 1e12);
    if (min > max) throw new Error('Check min exceeds max');
    const a = archive(directory, c.case_id), channel = integer(c.channel ?? 0, 'channel', 0, a.output.length - 1);
    const frequency = c.frequency_hz === undefined ? undefined : number(c.frequency_hz, 'frequency_hz', 1, a.sr * .49);
    const window = c.window_seconds ?? o.window_seconds;
    let value: number | null = null;
    if (c.metric === 'tone_gain_db') {
      if (a.stimulus.kind !== 'tone') throw new Error('tone_gain_db requires a continuous tone case');
      const [x, y] = aligned(a.input, a.output, lag), start = Math.max(0, x[channel].length - a.sr), hz = a.stimulus.frequency_hz ?? 1000, input = amplitude(x[channel].subarray(start), a.sr, hz);
      if (window === undefined) value = input > 1e-10 ? db(amplitude(y[channel].subarray(start), a.sr, hz) / input) : null;
      else {
        const w = analysisWindow(x[channel].length, a.sr, window, Math.max(0, -lag)), level = amplitude(x[channel].subarray(w.a, w.b), a.sr, hz);
        value = level > 1e-10 ? db(amplitude(y[channel].subarray(w.a, w.b), a.sr, hz) / level) : null;
      }
    } else if (c.metric === 'eq_gain_db' || c.metric === 'eq_phase_degrees') {
      if (window !== undefined) throw new Error('EQ checks use their impulse/noise analyzer; window_seconds is not supported for EQ metrics');
      if (frequency === undefined) throw new Error('EQ check requires frequency_hz');
      const point = eqResponse(directory, c.case_id, channel, [frequency], lag).points[0]; value = c.metric === 'eq_gain_db' ? point.gain_db : point.phase_degrees;
    } else if (c.metric === 'reported_latency_samples') value = a.result.plugin?.reported_latency_samples ?? null;
    else if (c.metric === 'impulse_peak_lag_samples') value = a.result.metrics?.impulse_peak_lag_samples ?? null;
    else if (String(c.metric).startsWith('candidate_')) {
      if (typeof o.candidate_run !== 'string') throw new Error('Candidate error check requires candidate_run');
      const b = archive(expand(o.candidate_run), c.case_id);
      if (a.sr !== b.sr || a.result.input_sha256 !== b.result.input_sha256 || a.output[channel].length !== b.output[channel]?.length) throw new Error('Candidate inputs and output shapes must match exactly');
      const e = candidateError(a.output, b.output, a.sr, candidateLag, window, o.reference_floor_dbfs).channels[channel];
      if (c.metric === 'candidate_relative_error_db') value = e.relative_mse === null ? null : e.exact_null ? -Infinity : e.relative_error_db;
      else if (c.metric === 'candidate_rms_error') value = e.rms_error;
      else if (c.metric === 'candidate_peak_error') value = e.peak_error;
      else value = e.exact_null ? -Infinity : c.metric === 'candidate_rms_error_dbfs' ? e.rms_error_dbfs : e.peak_error_dbfs;
    } else {
      const w = analysisWindow(a.output[channel].length, a.sr, window);
      value = stats([a.output[channel].subarray(w.a, w.b)])[0][c.metric as 'peak_dbfs' | 'rms_dbfs' | 'dc' | 'full_scale_fraction'];
    }
    const passed = value !== null && !Number.isNaN(value) && value >= min && value <= max;
    return { ...c, channel, value: value === -Infinity ? null : value, exact_null: value === -Infinity, passed, reason: value === null ? 'Metric unavailable or unexcited; missing values never pass' : passed ? 'Within inclusive bounds' : 'Outside inclusive bounds' };
  });
  mkdirSync(dirname(output), { recursive: true }); mkdirSync(output);
  const passed = rows.every(r => r.passed), report = join(output, 'verification.json');
  dump(report, { status: passed ? 'ok' : 'error', passed, reference_run_sha256: sha(join(directory, 'run.json')), ...(o.candidate_run ? { candidate_run_sha256: sha(join(expand(o.candidate_run as string), 'run.json')) } : {}), options: o, checks: rows });
  return { status: passed ? 'ok' : 'error', passed, report, checks: rows.length, failed: rows.filter(r => !r.passed) };
}

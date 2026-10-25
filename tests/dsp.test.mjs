import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { make } from '../dist/signals.js';
import { amplitude, stats } from '../dist/measure.js';
import { loadAudio, saveAudio } from '../dist/archive.js';
import { arraySha, dump, load, sha } from '../dist/io.js';
import { run, validate } from '../dist/runner.js';
import { aligned, compare } from '../dist/compare.js';

const near = (actual, expected, tolerance = 1e-5) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
test('multitone channel routing, phase, gates and validation are preserved', () => {
  const spec = { kind: 'multitone', tones: [{ frequency_hz: 1000, level_dbfs: -20, phase_degrees: 90, channel: 0 }, { frequency_hz: 500, level_dbfs: -20, phase_degrees: 90, channel: 1, on_seconds: .05, off_seconds: .08 }] };
  const x = make(spec, 8000, 2, .1);
  near(x[0][0], .1); near(x[1][400], .1);
  assert.ok(x[1].subarray(0, 400).every(v => v === 0)); assert.ok(x[1].subarray(640).every(v => v === 0));
  for (const change of [{ channel: 2 }, { phase_degrees: 361 }, { on_seconds: .08, off_seconds: .02 }, { frequency_hz: 4000 }]) assert.throws(() => make({ ...spec, tones: [{ ...spec.tones[0], ...change }] }, 8000, 2, .1));
  assert.throws(() => make({ ...spec, level_dbfs: -12 }, 8000, 2, .1));
});
test('gating covers the entire resonance driver while the seeded probe continues', () => {
  const spec = { kind: 'resonance', frequency_hz: 1000, competitor_hz: 1400, on_seconds: .05, off_seconds: .15, probe_kind: 'noise', probe_dbfs: -66, seed: 7 };
  const x = make(spec, 8000, 2, .2);
  assert.deepEqual(x, make(spec, 8000, 2, .2));
  assert.ok(x[0].subarray(0, 400).every(v => v === 0)); assert.ok(x[0].subarray(1200).every(v => v === 0));
  assert.ok(x[1].subarray(0, 400).some(v => v !== 0)); near(stats([x[1]])[0].rms_dbfs, -66);
  assert.throws(() => make(spec, 8000, 1, .2));
  const toneProbe = make({ ...spec, probe_kind: 'tone' }, 8000, 2, .2);
  near(20 * Math.log10(amplitude(toneProbe[1], 8000, 1000)), -66);
});
test('spectral gain, delay phase, single-segment coherence, bands and exact candidate input checks', async t => {
  const root = mkdtempSync(join(tmpdir(), 'fourier-calibration-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'run');
  const plan = join(root, 'plan.json');
  dump(plan, validate({ plugin: 'builtin:gain', sample_rate: 8000, channels: 1, duration: 2, cases: [{ id: 'tone', stimulus: { kind: 'tone', frequency_hz: 1000, level_dbfs: -18 } }] }));
  await run(plan, dir);
  const folder = join(dir, 'cases', 'tone'), file = join(folder, 'audio.npz'), audio = loadAudio(file);
  // Independently impose a known 0.5 gain and one-sample delay on the archived signal.
  const output = audio.input.map(ch => Float32Array.from(ch, (_, i) => i ? ch[i - 1] * .5 : 0));
  saveAudio(file, audio.input, output, 8000);
  const result = load(join(folder, 'result.json')); result.output_sha256 = arraySha(output); dump(join(folder, 'result.json'), result);
  const state = load(join(dir, 'run.json')); state.cases[0].result = result;
  for (const name of ['audio.npz', 'result.json']) state.cases[0].artifacts[name] = sha(join(folder, name));
  dump(join(dir, 'run.json'), state);
  compare(dir, join(root, 'spectral'), { frequencies_hz: [1000], window_seconds: [0, 2], band_hz: [900, 1100], times_seconds: [.5], window_ms: 80 });
  const channel = load(join(root, 'spectral', 'comparison.json')).cases[0].channels[0], f = channel.spectral_transfer[0];
  near(f.h1_gain_db, 20 * Math.log10(.5)); near(f.h1_phase_degrees, -45, .001); near(f.coherence, 1);
  near(channel.band_envelope[0].band_gain_db, 20 * Math.log10(.5)); near(f.input_bin_peak_dbfs, -18, .001);
  compare(dir, join(root, 'single'), { frequencies_hz: [1000], window_seconds: [.5, 1] });
  assert.equal(load(join(root, 'single', 'comparison.json')).cases[0].channels[0].spectral_transfer[0].coherence, null);
  const [a, b] = aligned(audio.input, output, 1); near(amplitude(b[0], 8000, 1000) / amplitude(a[0], 8000, 1000), .5);
  assert.throws(() => aligned(audio.input, output, .5));
  const candidate = join(root, 'candidate');
  dump(plan, validate({ ...state.spec, cases: [{ id: 'tone', stimulus: { kind: 'tone', frequency_hz: 1000, level_dbfs: -12 } }] }));
  await run(plan, candidate);
  assert.throws(() => compare(dir, join(root, 'invalid'), { candidate_run: candidate }), /inputs must match exactly/);
});

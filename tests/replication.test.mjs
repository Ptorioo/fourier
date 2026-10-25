import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execute } from '../dist/worker.js';
import { loadAudio } from '../dist/archive.js';
import { dump, load } from '../dist/io.js';
import { run, validate } from '../dist/runner.js';
import { match } from '../dist/match.js';
import { characterize, decayCurve } from '../dist/characterize.js';
import { create } from '../dist/juce.js';
import { snapshot } from '../dist/controls.js';

function temp(fn) { const dir = mkdtempSync(join(tmpdir(), 'fourier-match-')); return Promise.resolve().then(() => fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true })); }
test('all DSP choices generate complete projects and reject kind mismatches', () => temp(dir => {
  for (const [id, dsp] of ['gain', 'filter', 'compressor', 'saturation', 'delay', 'sine', 'subtractive'].entries()) {
    const project = join(dir, dsp), kind = id < 5 ? 'effect' : 'instrument';
    assert.equal(create(project, 'Starter', kind, 'Test', 'Strt', dsp).dsp, dsp);
    assert.match(readFileSync(join(project, 'StarterDSP.h'), 'utf8'), new RegExp(`#define FOURIER_STARTER ${id}`));
    assert.ok(!readFileSync(join(project, 'README.md'), 'utf8').includes('@DSP@'));
    assert.equal(load(join(project, 'fourier-project.json')).dsp, dsp);
  }
  assert.throws(() => create(join(dir, 'bad'), 'Starter', 'instrument', 'Test', 'Strt', 'delay'), /dsp must match/);
}));
const plan = (extra = {}) => validate({ plugin: 'builtin:gain', sample_rate: 8000, channels: 1, duration: .1, cases: [{ id: 'train', stimulus: { kind: 'tone', frequency_hz: 1000 } }, { id: 'held', stimulus: { kind: 'noise', seed: 2 } }], ...extra });
test('automation splits at rounded samples, preserves same-sample ordering and snapshots override defaults', () => temp(dir => {
  const request = { operation: 'render', plugin: 'builtin:gain', output: dir, parameters: {}, sample_rate: 8000, channels: 1, duration: .1, buffer_size: 128, stimulus: { kind: 'tone', frequency_hz: 1000 }, save_state: true, automation: [{ time: .010125, parameters: { gain_db: -6 } }, { time: .010125, parameters: { gain_db: -12 } }] };
  const result = execute(request), a = loadAudio(join(dir, 'audio.npz'));
  assert.equal(result.automation_readbacks[0].sample, 81); assert.equal(result.plugin.parameters.gain_db.value, -12); assert.equal(result.initial_plugin.parameters.gain_db.value, 0);
  assert.ok(Math.abs(a.output[0][79] - a.input[0][79]) < 1e-8); assert.ok(Math.abs(a.output[0][81] / a.input[0][81] - 10 ** (-12 / 20)) < 1e-6);
  const snap = join(dir, 'plugin-state.json'); const restored = execute({ ...request, save_state: false, automation: [], state_file: snap });
  assert.equal(restored.initial_plugin.parameters.gain_db.value, -12);
  assert.equal(execute({ ...request, save_state: false, automation: [], state_file: snap, parameters: { gain_db: 3 } }).plugin.parameters.gain_db.value, 3);
  assert.throws(() => execute({ ...request, plugin: 'builtin:clip', state_file: snap }), /identity/);
  assert.throws(() => execute({ ...request, sample_rate: 16000, state_file: snap }), /settings differ/);
  assert.throws(() => validate({ ...plan(), automation: [{ time: .1, parameters: { gain_db: 0 } }] }), /inside/);
  assert.throws(() => validate({ ...plan(), automation: [{ time: .05, parameters: { gain_db: 0 } }, { time: .01, parameters: { gain_db: 0 } }] }), /ordered/);
  assert.throws(() => execute({ ...request, automation: [{ time: .01, parameters: { unknown: 0 } }] }), /Unknown parameter/);
}));
test('native state accepts the 4 MiB boundary without regex-stack exhaustion and rejects noncanonical/oversized bytes', () => temp(dir => {
  const file = join(dir, 'state.json'), state = { schema_version: 1, plugin_sha256: 'test-hash', plugin_name: 'Test', backend: 'juce', sample_rate: 8000, channels: 1, buffer_size: 512, parameters: {}, data: Buffer.alloc(4 * 1024 * 1024).toString('base64') };
  dump(file, state); assert.equal(snapshot(file, 'test-hash', 'juce', 8000, 1, 512).data, state.data);
  for (const data of ['AA=', 'AB==', 'AAAA\n', 'A'.repeat(5_592_408), Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64')]) {
    dump(file, { ...state, data }); assert.throws(() => snapshot(file, 'test-hash', 'juce', 8000, 1, 512), /Invalid native state bytes/);
  }
}));
test('state is fingerprinted and archived, including snapshot tampering on resume', () => temp(async dir => {
  const capture = join(dir, 'capture'); mkdirSync(capture);
  execute({ operation: 'render', plugin: 'builtin:gain', output: capture, parameters: { gain_db: -6 }, sample_rate: 8000, channels: 1, duration: .1, buffer_size: 512, stimulus: { kind: 'tone' }, save_state: true });
  const stateFile = join(capture, 'plugin-state.json'), spec = join(dir, 'plan.json'), output = join(dir, 'run');
  dump(spec, plan({ state_file: stateFile, save_state: true }));
  const state = await run(spec, output, false, false); assert.equal(state.status, 'ok'); assert.ok(state.cases[0].artifacts['plugin-state.json']);
  dump(stateFile, { ...load(stateFile), parameters: { gain_db: 0 } });
  await assert.rejects(run(spec, output, true, false), /Resume refused/);
}));
test('paired suites share inputs, fit a bounded grid and keep held-out selection separate', () => temp(async dir => {
  const reference = join(dir, 'reference.json'), suite = join(dir, 'suite.json'); dump(reference, plan({ parameters: { gain_db: -6 } }));
  await match('create', { reference_plan: reference, candidate: { plugin: 'builtin:gain' }, held_out_case_ids: ['held'], out: suite });
  const saved = load(suite); assert.deepEqual(saved.candidate.parameters, {}); assert.equal(saved.candidate.cases[0].stimulus.kind, 'tone');
  const result = await match('fit', { suite, out: join(dir, 'fit'), grid: { gain_db: [-12, -6, 0] } });
  assert.deepEqual(result.best_tested_parameters, { gain_db: -6 }); assert.equal(result.fit_relative_mse, 0); assert.equal(result.held_out_relative_mse, 0);
  const report = load(result.report); assert.deepEqual(report.evaluations[0].fit.cases.map(c => c.id), ['train']);
  await assert.rejects(match('fit', { suite, out: join(dir, 'bad'), grid: { gain_db: Array(9).fill(0) } }), /Grid/);
  await assert.rejects(match('create', { reference_plan: reference, candidate: { plugin: 'builtin:gain', case_parameters: { typo: {} } }, out: join(dir, 'bad.json') }), /Unknown candidate case/);
  await assert.rejects(match('create', { reference_plan: reference, candidate: {}, out: join(dir, 'missing.json') }), /Explicit candidate/);
  const controls = join(dir, 'controls.json');
  await match('create', { reference_plan: reference, candidate: { plugin: 'builtin:gain', automation: [{ time: .02, parameters: { gain_db: -3 } }], case_controls: { train: { automation: [] } } }, out: controls });
  assert.deepEqual(load(controls).candidate.cases[0].automation, []);
  await assert.rejects(match('fit', { suite: controls, out: join(dir, 'shadowed'), grid: { gain_db: [-6] } }), /shadowed/);
  const notHeld = await match('run', { suite: controls, out: join(dir, 'paired') }); assert.equal(notHeld.held_out_evaluated, false);
  const silent = join(dir, 'silent-suite.json');
  dump(reference, plan({ cases: [{ id: 'silent', stimulus: { kind: 'silence' } }] }));
  await match('create', { reference_plan: reference, candidate: { plugin: 'builtin:gain' }, out: silent });
  await assert.rejects(match('fit', { suite: silent, out: join(dir, 'silent-fit'), grid: { gain_db: [0] } }), /silent reference/);
  assert.equal(load(join(dir, 'silent-fit/match.json')).status, 'error');
}));
test('selected IMD/THD distinguish clipping from a clean gain and reject gated/coincident fundamentals', () => temp(async dir => {
  const spec = join(dir, 'spec.json'), cases = [
    { id: 'tone', stimulus: { kind: 'tone', frequency_hz: 1000, level_dbfs: -6 } },
    { id: 'two', stimulus: { kind: 'multitone', tones: [{ frequency_hz: 1000, level_dbfs: -6 }, { frequency_hz: 1100, level_dbfs: -6 }] } },
    { id: 'same', stimulus: { kind: 'multitone', tones: [{ frequency_hz: 1000 }, { frequency_hz: 1000 }] } },
    { id: 'gated', stimulus: { kind: 'multitone', tones: [{ frequency_hz: 1000, off_seconds: .05 }] } },
    { id: 'impulse', stimulus: { kind: 'impulse' } },
  ];
  const results = [];
  for (const plugin of ['builtin:gain', 'builtin:clip']) {
    const name = plugin.split(':')[1], output = join(dir, name); dump(spec, plan({ plugin, cases })); assert.equal((await run(spec, output)).status, 'ok');
    const measured = characterize(output, join(dir, `${name}-measurement`), { case_ids: ['tone', 'two'], measurements: ['distortion'] }); results.push(load(measured.report));
  }
  assert.ok(results[0].cases[0].distortion.ratio_percent < .001); assert.ok(results[1].cases[0].distortion.ratio_percent > 10);
  assert.ok(results[0].cases[1].distortion.ratio_percent < .001); assert.ok(results[1].cases[1].distortion.ratio_percent > 1);
  assert.throws(() => characterize(join(dir, 'gain'), join(dir, 'same'), { case_ids: ['same'], measurements: ['distortion'] }), /distinct/);
  assert.throws(() => characterize(join(dir, 'gain'), join(dir, 'gated'), { case_ids: ['gated'], measurements: ['distortion'] }), /ungated/);
  const decay = characterize(join(dir, 'gain'), join(dir, 'impulse-analysis'), { case_ids: ['impulse'], measurements: ['decay'] });
  assert.equal(load(decay.report).cases[0].decay.t20, null);
}));
test('specialized measurements reject incoherent tones and recover analytic exponential decay', () => temp(async dir => {
  const spec = join(dir, 'plan.json'), output = join(dir, 'run'); dump(spec, plan({ cases: [{ id: 'tone', stimulus: { kind: 'tone', frequency_hz: 1000 } }] })); await run(spec, output, false, false);
  const result = characterize(output, join(dir, 'analysis'), { measurements: ['dynamics', 'distortion'] }), report = load(result.report);
  assert.ok(report.cases[0].distortion.ratio_percent < .001); assert.ok(report.cases[0].dynamics.envelope.length > 0);
  assert.throws(() => characterize(output, join(dir, 'bad'), { measurements: ['distortion'], window_seconds: [0, .099125] }), /integer-cycle/);
  assert.throws(() => characterize(output, join(dir, 'decay'), { measurements: ['decay'] }), /impulse/);
  const sr = 8000, response = Float32Array.from({ length: sr * 2 }, (_, i) => Math.exp(-i / sr * Math.log(1000) / .6));
  const d = decayCurve(response, sr, 0); assert.ok(Math.abs(d.t20.extrapolated_rt60_seconds - .6) < .001); assert.ok(d.t20.r_squared > .999);
  assert.equal(decayCurve(new Float32Array(100), sr, 0), null);
  assert.ok(readFileSync(result.report).length > 0);
}));

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump, load, sha } from '../dist/io.js';
import { parameterWarnings } from '../dist/metadata.js';
import { nativeHost, hostDoctor } from '../dist/host.js';
import { buildHost, build } from '../dist/juce.js';
import { eqResponse } from '../dist/eq.js';
import { inspect, run, validate } from '../dist/runner.js';
import { candidateError } from '../dist/audio-error.js';
import { compare } from '../dist/compare.js';
import { verify } from '../dist/verify.js';
import { expandMatrix, createMatrix } from '../dist/matrix.js';
import { modelPoint as eqResponseAt, fitEq } from '../dist/eq-model.js';
import { minimize } from '../dist/optimize.js';
import { match } from '../dist/match.js';
import { fitTransition, transitions } from '../dist/transitions.js';
import { exportModel } from '../dist/export-model.js';
import { workflow } from '../dist/workflow.js';

function temporary(t) { const dir = mkdtempSync(join(tmpdir(), 'fourier-upgrades-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
test('metadata reports ambiguous enumeration and invalid native readbacks without rewriting them', () => {
  const plugin = { parameters: { bypass: { id: 'x', value: 'Off', raw_value: 2, valid_values: ['Off', 'Off'] }, other: { id: 'x', name: '', value: 'bad', valid_values: [''] } } };
  const before = structuredClone(plugin), warnings = parameterWarnings(plugin);
  for (const code of ['ambiguous_enum', 'invalid_normalized_value', 'duplicate_id', 'empty_name', 'empty_enum_label', 'enum_readback_mismatch']) assert.ok(warnings.some(w => w.code === code), code);
  assert.deepEqual(plugin, before);
  assert.deepEqual(parameterWarnings({ parameters: { x: { value: 6 } } }), []);
});
test('inspection persists metadata diagnostics', async t => {
  const result = await inspect('builtin:gain', join(temporary(t), 'inspection'));
  assert.deepEqual(result.metadata_warnings, []);
  assert.deepEqual(load(result.inspection).metadata_warnings, []);
});
test('workspace native-host discovery is pinned and explicit selection still wins', t => {
  const dir = temporary(t), old = process.cwd(), env = process.env.FOURIER_NATIVE_HOST;
  try {
    process.chdir(dir); delete process.env.FOURIER_NATIVE_HOST;
    const file = join(dir, '.fourier/native-host.json');
    dump(file, { schema_version: 1, path: process.execPath, sha256: sha(process.execPath), source_sha256: 'test' });
    assert.equal(nativeHost(), process.execPath);
    assert.equal(hostDoctor().host_selection, 'workspace');
    dump(file, { schema_version: 1, path: process.execPath, sha256: 'wrong' });
    assert.throws(() => nativeHost(), /changed/);
    assert.equal(nativeHost(process.execPath), process.execPath);
  } finally { process.chdir(old); if (env === undefined) delete process.env.FOURIER_NATIVE_HOST; else process.env.FOURIER_NATIVE_HOST = env; }
});
test('native build rejects unknown options and malformed destinations before building', t => {
  const dir = temporary(t);
  assert.throws(() => buildHost({ surprise: true }), /Unknown native build/);
  assert.throws(() => buildHost({ build_directory: '', juce_path: dir }), /build_directory/);
  assert.throws(() => buildHost({ activate: 'yes', juce_path: dir }), /activate/);
  assert.equal(existsSync(join(dir, 'configure.log')), false);
});

test('candidate errors honor windows, signed lag, exact silence and explicit relative floors', () => {
  const a = [Float32Array.from({ length: 800 }, () => 1)], b = [Float32Array.from({ length: 800 }, (_, i) => i < 400 ? 0 : 1)];
  assert.ok(candidateError(a, b, 8000).channels[0].rms_error > .7);
  assert.equal(candidateError(a, b, 8000, 0, [.05, .1]).channels[0].rms_error, 0);
  const silent = [new Float32Array(800)];
  assert.equal(candidateError(silent, silent, 8000).channels[0].relative_mse, null);
  assert.equal(candidateError(silent, silent, 8000, 0, undefined, -120).channels[0].relative_mse, 0);
  assert.equal(candidateError(silent, silent, 8000).channels[0].exact_null, true);
  assert.equal(candidateError(a, a, 8000, -80, [.01, .05]).channels[0].samples, 320);
  assert.throws(() => candidateError(a, b, 8000, -80, [0, .05]), /overlap/);
  assert.throws(() => candidateError(a, b, 8000, 0, [.05, .05]), /32 frames/);
});
test('comparison and verification share windowed and absolute candidate metrics', async t => {
  const dir = temporary(t), spec = join(dir, 'plan.json');
  const plan = validate({ plugin: 'builtin:gain', sample_rate: 8000, channels: 1, duration: .1, cases: [{ id: 'tone', stimulus: { kind: 'tone' } }, { id: 'silent', stimulus: { kind: 'silence' } }] });
  dump(spec, plan); await run(spec, join(dir, 'reference'));
  dump(spec, { ...plan, parameters: { gain_db: -6 }, automation: [{ time: .05, parameters: { gain_db: 0 } }] }); await run(spec, join(dir, 'candidate'));
  const options = { candidate_run: join(dir, 'candidate'), window_seconds: [.05, .1] };
  const compared = compare(join(dir, 'reference'), join(dir, 'comparison'), options);
  assert.equal(load(compared.report).cases[0].comparison.channels[0].rms_error, 0);
  const checks = [{ case_id: 'tone', metric: 'candidate_rms_error_dbfs', max: -120 }, { case_id: 'silent', metric: 'candidate_peak_error', max: 0 }];
  assert.equal(verify(join(dir, 'reference'), join(dir, 'pass'), { ...options, checks }).passed, true);
  assert.equal(verify(join(dir, 'reference'), join(dir, 'fail'), { ...options, window_seconds: [0, .05], checks }).passed, false);
  assert.equal(verify(join(dir, 'reference'), join(dir, 'floor'), { candidate_run: join(dir, 'reference'), reference_floor_dbfs: -120, checks: [{ case_id: 'silent', metric: 'candidate_relative_error_db', max: -120 }] }).passed, true);
});
test('matrix expansion covers coupled controls, stimuli and audio settings, without loading', t => {
  const dir = temporary(t), plan = { plugin: 'builtin:gain', sample_rate: 8000, channels: 1, duration: .1, cases: [{ id: 'tone', stimulus: { kind: 'tone' } }] };
  const axes = [{ kind: 'parameter', name: 'gain_db', values: [-6, 0] }, { kind: 'stimulus', name: 'frequency_hz', values: [500, 1000] }, { kind: 'setting', name: 'sample_rate', values: [8000, 16000] }];
  const expanded = expandMatrix({ plan, axes }); assert.equal(expanded.plans.length, 2); assert.equal(expanded.plans[0].plan.cases.length, 4);
  assert.equal(expanded.plans[0].plan.cases[0].parameters.gain_db, -6);
  assert.equal(expanded.plans[1].plan.sample_rate, 16000);
  const created = createMatrix({ plan, axes, out_directory: join(dir, 'matrix') }); assert.equal(created.total_cases, 8); assert.equal(created.plugins_loaded, 0);
  assert.throws(() => createMatrix({ plan, axes, out_directory: created.directory }), /EEXIST/);
  assert.throws(() => expandMatrix({ plan, axes: [axes[0], axes[0]] }), /distinct/);
  assert.throws(() => expandMatrix({ plan: { ...plan, automation: [{ time: .05, parameters: { gain_db: 1 } }] }, axes: [axes[0]] }), /shadowed/);
  assert.throws(() => expandMatrix({ plan, axes: [{ ...axes[0], values: Array.from({ length: 16 }, (_, i) => i) }, { ...axes[1], values: Array.from({ length: 16 }, (_, i) => 100 + i) }] }), /64 cases/);
});

test('six-section Butterworth models have analytic cutoff gain and distinct fitted topology', () => {
  const model = { family: 'low_pass', stages: 6, frequency_hz: 2400, q: Math.SQRT1_2, gain_db: 0, topology: 'butterworth' };
  assert.ok(Math.abs(eqResponseAt(model, 48000, 2400).gain_db + 3.0103) < .0001);
  const points = Array.from({ length: 96 }, (_, i) => { const frequency_hz = 50 * 200 ** (i / 95); return { frequency_hz, bin_hz: frequency_hz, coherence: 1, ...eqResponseAt(model, 48000, frequency_hz) }; });
  const fit = fitEq(points, 48000, ['low_pass'], [3, 6]);
  assert.equal(fit.best.model.topology, 'butterworth'); assert.equal(fit.best.model.stages, 6); assert.equal(fit.accepted, true);
  assert.ok(fit.best.held_out.magnitude_rmse_db < .05);
  for (const family of ['bell', 'notch', 'high_pass', 'low_shelf', 'high_shelf', 'band_pass']) for (const stages of [1, 2, 5, 6, 8]) {
    const point = eqResponseAt({ ...model, family, stages, gain_db: 1 }, 48000, 2400);
    assert.ok(Number.isFinite(point.gain_db) && Number.isFinite(point.phase_degrees), `${family}/${stages}`);
  }
});
test('bounded continuous optimizer solves coupled controls, caches and respects evaluation budget', async () => {
  const fit = await minimize({ bounds: [[-3, 3], [-300, 300]], initial: [1, -100], max_evaluations: 128 }, async ([x, y]) => (x + y / 100 - .7) ** 2 + (x - y / 100 - .1) ** 2);
  assert.ok(Math.abs(fit.best.point[0] - .4) < .001); assert.ok(Math.abs(fit.best.point[1] - 30) < .1); assert.ok(fit.evaluations <= 128);
  await assert.rejects(minimize({ bounds: [[0, 1]], initial: [2], max_evaluations: 10 }, async () => 0), /Invalid bounded/);
});
test('continuous plug-in match archives every trial and excludes held-out cases from selection', async t => {
  const root = temporary(t), plan = join(root, 'plan.json'), suite = join(root, 'suite.json');
  dump(plan, validate({ plugin: 'builtin:gain', sample_rate: 8000, channels: 1, duration: .05, parameters: { gain_db: -3.5 }, cases: [{ id: 'train', stimulus: { kind: 'tone', frequency_hz: 1000 } }, { id: 'held', stimulus: { kind: 'tone', frequency_hz: 500 } }] }));
  await match('create', { reference_plan: plan, out: suite, held_out_case_ids: ['held'], candidate: { plugin: 'builtin:gain', parameters: { gain_db: 0 } } });
  const result = await match('optimize', { suite, out: join(root, 'fit'), window_seconds: [.01, .05], search: { bounds: { gain_db: [-12, 6] }, max_evaluations: 24 } });
  assert.ok(Math.abs(result.best_tested_parameters.gain_db + 3.5) < .02); assert.equal(result.held_out_evaluated, true);
  const evidence = load(result.report); assert.ok(evidence.evaluations.length <= 24); assert.equal(evidence.evaluations[0].fit.cases.length, 1); assert.equal(evidence.evaluations[0].fit.cases[0].id, 'train');
});
test('transition identification distinguishes first-order smoothing and preserves a held-out tail', async () => {
  const sr = 8000, at = .1, input = Float32Array.from({ length: 2400 }, (_, i) => Math.sin(2 * Math.PI * 500 * i / sr));
  const after = Float32Array.from(input, v => v * 2), actual = Float32Array.from(input, (v, i) => v * (i / sr < at ? 1 : 2 - Math.exp(-(i / sr - at) / .02)));
  const result = await fitTransition([input], [after], [actual], sr, at, [.1, .3]);
  assert.equal(result.best.kind, 'first_order'); assert.ok(Math.abs(result.best.duration_seconds - .02) < .001); assert.equal(result.accepted, true);
  await assert.rejects(fitTransition([input], [input], [input], sr, at, [.1, .3]), /indistinguishable/);
});
test('transition create/run collects fixed endpoints, automation and saved state', async t => {
  const root = temporary(t), plan = join(root, 'plan.json'), suite = join(root, 'suite.json');
  dump(plan, validate({ plugin: 'builtin:gain', sample_rate: 8000, channels: 1, duration: .2, cases: [{ id: 'carrier', stimulus: { kind: 'tone', frequency_hz: 500 } }] }));
  const created = await transitions('create', { plan_file: plan, out_file: suite, transitions: [{ id: 'step', at_seconds: .1, before_parameters: { gain_db: -6 }, after_parameters: { gain_db: 0 } }] });
  assert.equal(created.cases, 3);
  const result = await transitions('run', { suite, out_directory: join(root, 'transition') });
  assert.equal(result.accepted, 1); assert.equal(result.models[0].kind, 'immediate');
  assert.ok(load(join(root, 'transition', 'run', 'run.json')).spec.cases.every(c => c.save_state));
});
test('fitted source export emits sample-rate-adaptive SOS and refuses unaccepted fits/overwrite', t => {
  const root = temporary(t), report = join(root, 'fit.json'), project = join(root, 'project');
  const row = { id: 'lp', band: 'lp', parameter: null, fit: { accepted: true, ambiguous: false, best: { model: { family: 'low_pass', stages: 6, frequency_hz: 2400, q: Math.SQRT1_2, gain_db: 0, topology: 'butterworth' } } } };
  dump(report, { status: 'ok', effect: 'filter', rows: [row] });
  const result = exportModel({ report, project_directory: project, name: 'ExportedFilter' });
  assert.equal(result.sections, 6); assert.equal(load(result.provenance).source_sha256, sha(report));
  assert.equal(result.kind, 'fixed_control_surrogate'); assert.deepEqual(result.row_ids, ['lp']);
  assert.match(readFileSync(join(project, 'README.md'), 'utf8'), /^# Exported fixed-control surrogate[\s\S]*Selected rows: lp\.[\s\S]*neutral baseline/);
  assert.match(readFileSync(join(project, 'StarterDSP.h'), 'utf8'), /std::tan/);
  assert.throws(() => exportModel({ report, project_directory: project, name: 'ExportedFilter' }), /EEXIST/);
  row.fit.accepted = false; dump(report, { status: 'ok', effect: 'filter', rows: [row] });
  assert.throws(() => exportModel({ report, project_directory: join(root, 'rejected'), name: 'Rejected' }), /Refusing/);
  assert.equal(existsSync(join(root, 'rejected')), false);
  row.fit.accepted = true; row.fit.best.model = { family: 'flat', stages: 1, frequency_hz: 1000, q: 1, gain_db: 6 }; dump(report, { status: 'ok', effect: 'filter', rows: [row] });
  const flat = exportModel({ report, project_directory: join(root, 'flat'), name: 'FlatGain' });
  assert.equal(flat.sections, 0); assert.ok(readFileSync(join(flat.project_directory, 'StarterDSP.h'), 'utf8').includes(`input * ${(10 ** (6 / 20)).toPrecision(17)}`));
});
test('native workspace host build and exported SOS compile/render at independent sample rates', { skip: !process.env.FOURIER_JUCE_PATH, timeout: 600000 }, async t => {
  const root = temporary(t), juce_path = process.env.FOURIER_JUCE_PATH;
  const host = buildHost({ juce_path, build_directory: join(root, 'host'), jobs: 4, activate: false });
  assert.equal(host.capabilities.capabilities.render, true); assert.equal(host.activated, false);
  const report = join(root, 'fit.json'), model = { family: 'low_pass', stages: 6, frequency_hz: 2400, q: Math.SQRT1_2, gain_db: 0, topology: 'butterworth' };
  dump(report, { status: 'ok', effect: 'filter', rows: [{ id: 'lp', band: 'lp', parameter: null, fit: { accepted: true, ambiguous: false, best: { model } } }] });
  const project = exportModel({ report, project_directory: join(root, 'plugin'), name: 'FittedSOS' });
  const binary = build(project.project_directory, { juce_path, jobs: 4 });
  await inspect(binary.plugin, join(root, 'inspect'), 30, undefined, host.host);
  for (const sample_rate of [8000, 44100, 96000]) {
    const plan = join(root, `${sample_rate}.json`), output = join(root, `run-${sample_rate}`);
    dump(plan, validate({ plugin: binary.plugin, native_host: host.host, sample_rate, channels: 1, duration: .25, cases: [{ id: 'impulse', stimulus: { kind: 'impulse', at_seconds: .05 } }] }));
    assert.equal((await run(plan, output)).status, 'ok');
    const response = eqResponse(output, 'impulse', 0, [500, 2400, 3200]);
    for (const point of response.points) assert.ok(Math.abs(point.gain_db - eqResponseAt(model, sample_rate, point.bin_hz).gain_db) < .02, `${sample_rate}/${point.bin_hz}`);
  }
});
test('workflow chains references internally with compact output and stops on failed verification', async t => {
  const root = temporary(t), args = { plugin: 'builtin:gain', preset: 'effect', out_file: join(root, 'plan.json'), sample_rate: 8000, channels: 1, duration: .05, cases: [{ id: 'tone', stimulus: { kind: 'tone' } }] };
  const steps = [{ id: 'plan', operation: 'plan', arguments: args }, { id: 'render', operation: 'run', arguments: { spec_path: { $ref: 'plan.plan' }, out_directory: join(root, 'run') } }, { id: 'check', operation: 'verify', arguments: { run_directory: { $ref: 'render.directory' }, out_directory: join(root, 'verify'), checks: [{ case_id: 'tone', metric: 'tone_gain_db', min: -.01, max: .01 }] } }];
  const result = await workflow({ out_directory: join(root, 'workflow'), steps }); assert.equal(result.completed, 3); assert.ok(JSON.stringify(result).length < 3000);
  const bad = structuredClone(steps); bad[0].arguments.out_file = join(root, 'bad-plan.json'); bad[1].arguments.out_directory = join(root, 'bad-run'); bad[2].arguments.out_directory = join(root, 'bad-verify'); bad[2].arguments.checks[0].min = 1;
  bad.push({ id: 'never', operation: 'plan', arguments: { ...args, out_file: join(root, 'never.json') } });
  await assert.rejects(workflow({ out_directory: join(root, 'failed'), steps: bad }), /stopped without retries/); assert.equal(existsSync(join(root, 'never.json')), false); assert.equal(load(join(root, 'failed', 'workflow.json')).status, 'error');
});

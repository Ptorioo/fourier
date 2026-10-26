import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostDoctor, nativeHost, checkHost } from '../dist/host.js';
import { dump, load } from '../dist/io.js';
import { inspect, preset, run, validate } from '../dist/runner.js';
import { identifyEq, mappingLaws } from '../dist/eq-identify.js';
import { eqFamilies, fitEq, modelPoint } from '../dist/eq-model.js';
import { characterizeEq, eqFrequencies, eqResponse } from '../dist/eq.js';
import { verify } from '../dist/verify.js';
import { runBackend } from '../scripts/bridge.mjs';
const temporary = t => { const dir = mkdtempSync(join(tmpdir(), 'fourier-eq-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };

test('host selection fails closed and doctor reports incompatible/missing helpers', async t => {
  const dir = temporary(t), missing = join(dir, 'missing.exe');
  assert.throws(() => nativeHost(missing), /Native host not found/);
  const status = hostDoctor(missing); assert.equal(status.plugins_ready, false); assert.equal(status.host_selection, 'explicit');
  assert.equal(hostDoctor(process.execPath).plugins_ready, false);
  assert.throws(() => checkHost(process.execPath), /capability check failed/);
  // An executable path alone is not readiness. No output/worker is created before preflight.
  const plugin = join(dir, 'not-loaded.vst3'); writeFileSync(plugin, 'not executable');
  await assert.rejects(inspect(plugin, join(dir, 'inspect'), 10, undefined, process.execPath), /capability check failed/);
  assert.equal(existsSync(join(dir, 'inspect')), false);
  assert.throws(() => validate({ ...preset('builtin:gain'), native_host: '' }), /non-empty/);
  assert.equal(validate({ ...preset('builtin:gain'), native_host: missing }).native_host, missing);
});

test('EQ preset, verified response curves and declarative assertions work without native code', async t => {
  const dir = temporary(t), spec = join(dir, 'plan.json'), output = join(dir, 'run');
  dump(spec, { ...preset('builtin:gain', 'eq'), duration: .5, channels: 1, parameters: { gain_db: 6 } });
  assert.equal((await run(spec, output)).status, 'ok');
  const eq = characterizeEq(output, join(dir, 'eq'), { case_ids: ['impulse'], frequencies_hz: [100, 1000, 10000] });
  const curve = load(eq.report).cases[0].points;
  for (const p of curve) { assert.ok(Math.abs(p.gain_db - 6) < 1e-5); assert.ok(Math.abs(p.phase_degrees) < 1e-5); }
  const checks = [{ case_id: 'impulse', metric: 'eq_gain_db', frequency_hz: 1000, min: 5.99, max: 6.01 }, { case_id: 'tone_1000', metric: 'tone_gain_db', min: 5.99, max: 6.01 }, { case_id: 'impulse', metric: 'candidate_relative_error_db', max: -120 }];
  assert.equal(verify(output, join(dir, 'pass'), { checks, candidate_run: output }).passed, true);
  assert.equal(verify(output, join(dir, 'fail'), { checks: [{ case_id: 'tone_1000', metric: 'tone_gain_db', max: 1 }] }).status, 'error');
  assert.throws(() => verify(output, join(dir, 'bad'), { checks: [{ case_id: 'impulse', metric: 'eq_gain_db', min: 0 }] }), /frequency_hz/);
  assert.throws(() => eqResponse(output, 'tone_1000'), /impulse or continuous noise/);
  const options = join(dir, 'checks.json'); dump(options, { checks });
  const cli = await runBackend(['verify', '--run', output, '--out', join(dir, 'cli-fail'), '--options', options]);
  assert.notEqual(cli.code, 0); // Missing explicit candidate_run is an error, never an implicit self-comparison.
});

test('bounded EQ identification selects known RBJ families and checks held-out frequencies', () => {
  assert.ok(Math.abs(modelPoint({ family: 'bell', stages: 1, frequency_hz: 1000, q: 1, gain_db: 6 }, 48000, 1000).gain_db - 6) < 1e-9);
  for (const family of eqFamilies) {
    const expected = { family, stages: 1, frequency_hz: 1270, q: 1.4, gain_db: -9 };
    const points = eqFrequencies(48000, 128).map(f => ({ requested_hz: f, bin_hz: f, coherence: null, ...modelPoint(expected, 48000, f) }));
    const fitted = fitEq(points, 48000);
    assert.equal(fitted.best.model.family, family, JSON.stringify(fitted.best));
    assert.equal(fitted.accepted, true, JSON.stringify(fitted.best));
    assert.ok(fitted.best.held_out.magnitude_rmse_db < .03);
    assert.ok(Math.abs(Math.log(fitted.best.model.frequency_hz / expected.frequency_hz)) < .01);
  }
  const fourthOrder = { family: 'low_pass', stages: 2, frequency_hz: 2200, q: .8, gain_db: 0 };
  const fourthPoints = eqFrequencies(48000).map(f => ({ requested_hz: f, bin_hz: f, coherence: null, ...modelPoint(fourthOrder, 48000, f) }));
  assert.equal(fitEq(fourthPoints, 48000).best.model.stages, 2);
  const flat = eqFrequencies(48000).map(f => ({ requested_hz: f, bin_hz: f, coherence: null, gain_db: 0, phase_degrees: 0 }));
  assert.equal(fitEq(flat, 48000).ambiguous, true);
  assert.throws(() => fitEq(flat.slice(0, 10), 48000), /at least 24/);
});

test('control laws reserve held-out samples and report failed validation', () => {
  const samples = [0, .25, .5, .75, 1].map((x, i) => ({ x, y: -18 + 36 * x, held_out: i === 4 }));
  const law = mappingLaws(samples)[0];
  assert.equal(law.form, 'y = a + b*x'); assert.ok(Math.abs(law.b - 36) < 1e-10); assert.equal(law.held_out_validated, true);
  samples[4].y = 100; assert.equal(mappingLaws(samples)[0].held_out_validated, false);
  assert.deepEqual(mappingLaws(samples.map(s => ({ ...s, y: 0 }))), []);
  const power = mappingLaws([.2, .3, .4, .5, .6].map((x, i) => ({ x, y: 20 + 19980 * x ** 4.35, held_out: i === 4 })))[0];
  assert.ok(Math.abs(power.exponent - 4.35) < .001); assert.equal(power.held_out_validated, true);
});

test('identification suite create/run/analyze is reusable and refuses mismatched runs', async t => {
  const dir = temporary(t), suite = join(dir, 'suite.json');
  const design = { plugin: 'builtin:gain', neutral_parameters: { gain_db: 0 }, bands: [{ id: 'test', parameters: { gain_db: 6 }, controls: [{ parameter: 'gain_db', values: [-6, -3, 3, 6] }] }], duration: .5, channels: 1, families: ['bell'], stages: [1] };
  const created = await identifyEq('create', { ...design, out_file: suite }); assert.equal(created.cases, 6);
  const executed = await identifyEq('run', { suite, out_directory: join(dir, 'execution') });
  assert.equal(executed.fits, 5); assert.equal(executed.ambiguous, 5); // A flat gain cannot identify frequency/Q.
  const report = load(executed.report); assert.equal(report.mappings[0].targets[0].laws.length, 0);
  await assert.rejects(identifyEq('create', { ...design, out_file: suite }), /EEXIST/);
  await assert.rejects(identifyEq('create', { ...design, out_file: join(dir, 'bad.json'), neutral_parameters: {} }), /neutral_parameters/);
  dump(join(dir, 'changed.json'), { schema_version: 1, design: { ...design, duration: .6 } });
  await assert.rejects(identifyEq('analyze', { suite: join(dir, 'changed.json'), run_directory: join(dir, 'execution', 'run'), out_directory: join(dir, 'invalid') }), /does not match/);
});

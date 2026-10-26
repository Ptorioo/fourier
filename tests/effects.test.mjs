import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump, load } from '../dist/io.js';
import { run, validate } from '../dist/runner.js';
import { effectKinds, effectResponse, characterizeEffects, echoResponse, modulationTrace } from '../dist/effects.js';
import { dynamicsPoint, saturationPoint, fitDynamics, fitSaturation, fitDelay, fitReverb, fitModulation, fitEffect } from '../dist/effects-model.js';
import { identifyEffects } from '../dist/effects-identify.js';
import { eqFrequencies } from '../dist/eq.js';
import { modelPoint } from '../dist/eq-model.js';
import { characterize } from '../dist/characterize.js';
const temporary = t => { const dir = mkdtempSync(join(tmpdir(), 'fourier-effects-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const near = (a, b, tolerance) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b} within ${tolerance}`);

test('static compressor and limiter fits reserve levels and reject unexcited knees', () => {
  const inputs = Array.from({ length: 25 }, (_, i) => -60 + i * 2.4);
  for (const limiter of [false, true]) {
    const slope = limiter ? 0 : .25, points = inputs.map(input_db => ({ input_db, output_db: dynamicsPoint(input_db, -24, slope, 3, limiter ? 0 : 6) }));
    const fit = fitDynamics(points, limiter);
    assert.equal(fit.accepted, true, JSON.stringify(fit)); near(fit.model.threshold_db, -24, .5); near(fit.model.slope_above, slope, .01); near(fit.model.makeup_db, 3, .1); assert.ok(fit.held_out_error < .1);
  }
  assert.equal(fitDynamics(inputs.map(input_db => ({ input_db, output_db: input_db + 2 }))).accepted, false);
  assert.throws(() => fitDynamics([]), /8..256/);
});

test('memoryless waveshapers fit drive and output gain without fitting held-out pairs', () => {
  for (const family of ['tanh', 'hard_clip', 'cubic_clip']) {
    const pairs = Array.from({ length: 1000 }, (_, i) => { const x = Math.sin(i * .117) * .9; return { x, y: .6 * saturationPoint(x, family, 3.5) }; });
    const fit = fitSaturation(pairs); assert.equal(fit.model.family, family); assert.equal(fit.accepted, true); near(fit.model.drive, 3.5, .01); near(fit.model.output_gain, .6, .001);
    const changed = pairs.map((p, i) => i % 4 === 0 ? { ...p, y: -p.y } : p), failed = fitSaturation(changed);
    near(failed.model.drive, fit.model.drive, 1e-10); assert.equal(failed.accepted, false);
  }
  assert.throws(() => fitSaturation(Array.from({ length: 64 }, () => ({ x: 0, y: 0 }))), /excited/);
});

test('integer feedback delays validate the tail and reject unsupported/silent tails', () => {
  const sr = 8000, response = new Float64Array(sr); response[0] = .4;
  for (let i = 1; i * 400 < response.length; i++) response[i * 400] = .6 * (-.6) ** (i - 1);
  const fit = fitDelay(response, sr); assert.equal(fit.accepted, true); assert.equal(fit.model.delay_samples, 400); near(fit.model.feedback, -.6, 1e-12); near(fit.model.wet_gain, .6, 1e-12);
  const echo = echoResponse(response, sr, 0, 1, -60, 1); assert.equal(echo.peak_delay_samples, 400); assert.equal(echo.taps[1].delay_samples, 400); assert.ok(echo.energy_spread_seconds > 0);
  response[7001] = .2; assert.equal(fitDelay(response, sr).accepted, false);
  const direct = new Float64Array(100); direct[0] = 1; assert.equal(fitDelay(direct, sr).accepted, false);
  assert.equal(echoResponse(new Float64Array(100), sr, 0, 1, -60, 1), null);
});

test('reverb models measure exponential decay, never claim topology recovery', () => {
  const sr = 8000, response = Float64Array.from({ length: sr * 2 }, (_, i) => Math.exp(-i / sr * Math.log(1000) / .6));
  const fit = fitReverb(response, sr); assert.equal(fit.accepted, true); assert.equal(fit.ambiguous, true); near(fit.model.rt60_seconds, .6, .001);
  assert.throws(() => fitReverb(new Float64Array(100), sr), /excited/);
});

test('carrier trajectories recover sine modulation and distinguish constant/too-short probes', () => {
  const points = Array.from({ length: 500 }, (_, i) => ({ seconds: i * .02, gain: .75 + .2 * Math.cos(2 * Math.PI * .8 * i * .02), phase_degrees: 15 * Math.sin(2 * Math.PI * .8 * i * .02) }));
  const fit = fitModulation(points); assert.equal(fit.accepted, true, JSON.stringify(fit)); near(fit.model.rate_hz, .8, .0001); near(fit.model.gain_offset, .75, .001);
  assert.equal(fitModulation(points.map(p => ({ ...p, gain: 1, phase_degrees: 0 }))).accepted, false);
  const sr = 8000, x = Float64Array.from({ length: sr }, (_, i) => Math.sin(2 * Math.PI * 1000 * i / sr)), y = Float64Array.from(x, v => v * .5);
  const trace = modulationTrace(x, y, sr, 1000, 0, 20); assert.equal(trace.envelope.length, 50); near(trace.envelope[0].gain_db, 20 * Math.log10(.5), 1e-9);
  assert.throws(() => modulationTrace(x, y, sr, 997, 0, 20), /integer carrier cycles/);
});

test('EQ/filter observations and model fits reuse the existing phase-aware RBJ fitter', () => {
  assert.ok(effectKinds.includes('eq')); assert.ok(effectKinds.includes('filter'));
  const model = { family: 'low_pass', stages: 2, frequency_hz: 2200, q: .8, gain_db: 0 }, points = eqFrequencies(48000).map(f => ({ requested_hz: f, bin_hz: f, coherence: null, ...modelPoint(model, 48000, f) }));
  for (const effect of ['eq', 'filter']) { const fit = fitEffect(effect, [{ kind: 'eq', sample_rate: 48000, points }]); assert.equal(fit.accepted, true); assert.equal(fit.model.family, model.family); assert.equal(fit.model.stages, 2); assert.ok(fit.eq_diagnostics.best.held_out.phase_rmse_degrees < 1); }
  assert.throws(() => fitEffect('delay', [{ kind: 'eq', sample_rate: 48000, points }]), /do not match/);
});

test('unified suite create/run/reanalyze works on archived saturation with held-out controls', async t => {
  const dir = temporary(t), suite = join(dir, 'suite.json'), design = { effect: 'saturation', plugin: 'builtin:clip', parameters: { threshold: .25 }, controls: [{ parameter: 'threshold', values: [.15, .25, .35, .45] }], sample_rate: 8000, duration: .5 };
  const created = await identifyEffects('create', { ...design, out_file: suite }); assert.equal(created.cases, 15);
  const result = await identifyEffects('run', { suite, out_directory: join(dir, 'execution') }), report = load(result.report);
  assert.equal(result.fits, 5); assert.equal(result.accepted, 5); assert.equal(result.model.family, 'hard_clip'); near(result.model.drive, 4, .01);
  assert.equal(report.mappings[0].targets.find(t => t.target === 'output_gain').laws[0].held_out_validated, true);
  assert.equal(report.rows.at(-1).held_out, true);
  const archive = join(dir, 'execution', 'run');
  const measured = characterizeEffects(archive, join(dir, 'measured'), { effect: 'saturation', case_ids: ['anchor_probe2'] }); assert.equal(load(measured.report).cases[0].observation.kind, 'saturation');
  const reanalyzed = await identifyEffects('analyze', { suite, run_directory: archive, out_directory: join(dir, 'again') }); assert.deepEqual(reanalyzed.model, result.model);
  dump(join(dir, 'changed.json'), { schema_version: 1, design: { ...design, duration: .6 } });
  await assert.rejects(identifyEffects('analyze', { suite: join(dir, 'changed.json'), run_directory: archive, out_directory: join(dir, 'invalid') }), /does not match/);
  await assert.rejects(identifyEffects('create', { ...design, out_file: suite }), /EEXIST/);
  await assert.rejects(identifyEffects('create', { ...design, parameters: {}, out_file: join(dir, 'empty.json') }), /parameters required/);
  await assert.rejects(identifyEffects('create', { ...design, effect: 'compressor', controls: [{ parameter: 'threshold', values: [0, .1, .2, .3, .4, .5, .6, .7] }], out_file: join(dir, 'large.json') }), /64 cases/);
  assert.equal(existsSync(join(dir, 'large.json')), false);
});

test('EQ/filter identification uses unified tools and report names', async t => {
  const dir = temporary(t);
  for (const effect of ['eq', 'filter']) {
    const suite = join(dir, `${effect}.json`), out = join(dir, effect);
    await identifyEffects('create', { effect, plugin: 'builtin:gain', out_file: suite, neutral_parameters: { gain_db: 0 }, bands: [{ id: 'one', parameters: { gain_db: 6 } }], sample_rate: 8000, channels: 1, duration: .5, families: ['bell'], stages: [1] });
    assert.equal(load(suite).design.effect, effect);
    const result = await identifyEffects('run', { suite, out_directory: out }); assert.equal(result.effect, effect); assert.equal(result.fits, 1);
    assert.equal(result.report, join(out, 'analysis', 'effects-identification.json'));
    assert.equal(load(result.report).effect, effect);
    assert.ok(existsSync(join(out, 'analysis', 'EFFECTS_IDENTIFICATION.md')));
    const again = await identifyEffects('analyze', { suite, run_directory: join(out, 'run'), out_directory: join(dir, `${effect}-again`) });
    assert.deepEqual(again.models, result.models);
    const measured = effectResponse(join(out, 'run'), 'band0', effect); assert.equal(measured.kind, 'eq'); near(measured.points[10].gain_db, 6, .0001);
    const report = characterizeEffects(join(out, 'run'), join(dir, `${effect}-measured`), { effect, case_ids: ['band0'], frequencies_hz: [1000] }); assert.equal(load(report.report).cases[0].observation.points.length, 1);
  }
});

test('identification requires explicit effect types instead of legacy EQ fallback', async t => {
  const dir = temporary(t), suite = join(dir, 'suite.json'), output = join(dir, 'output');
  const design = { plugin: 'builtin:gain', neutral_parameters: { gain_db: 0 }, bands: [{ id: 'one', parameters: { gain_db: 6 } }] };
  await assert.rejects(identifyEffects('create', { ...design, out_file: suite }), /Select a supported effect/);
  assert.equal(existsSync(suite), false);
  dump(suite, { schema_version: 1, design });
  for (const action of ['run', 'analyze']) await assert.rejects(identifyEffects(action, { suite, out_directory: output }), /Select a supported effect/);
  assert.equal(existsSync(output), false);
  await assert.rejects(identifyEffects('unknown', {}), /action must be create, run or analyze/);
});

test('echo and modulation measurements are available via characterization and validate stimuli', async t => {
  const dir = temporary(t), spec = join(dir, 'plan.json'), output = join(dir, 'run');
  dump(spec, validate({ plugin: 'builtin:delay', parameters: { delay_samples: 400 }, sample_rate: 8000, channels: 1, duration: 1, cases: [{ id: 'impulse', stimulus: { kind: 'impulse', at_seconds: .25 } }, { id: 'tone', stimulus: { kind: 'tone', frequency_hz: 1000 } }] }));
  assert.equal((await run(spec, output)).status, 'ok');
  const echo = characterize(output, join(dir, 'echo'), { case_ids: ['impulse'], measurements: ['echo'] }); assert.equal(load(echo.report).cases[0].echo.peak_delay_samples, 400);
  const trace = characterize(output, join(dir, 'modulation'), { case_ids: ['tone'], measurements: ['modulation'], window_ms: 20 }); assert.ok(load(trace.report).cases[0].modulation.envelope.length > 0);
  assert.throws(() => effectResponse(output, 'tone', 'delay'), /requires an impulse/);
  assert.throws(() => effectResponse(output, 'impulse', 'saturation'), /continuous tones/);
  assert.throws(() => characterize(output, join(dir, 'bad'), { case_ids: ['tone'], measurements: ['echo'] }), /impulse/);
});

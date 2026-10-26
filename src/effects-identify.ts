import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { params } from './controls.js';
import { effectKinds, effectResponse, observationSummary, type EffectKind } from './effects.js';
import { fitEffect } from './effects-model.js';
import { identifyEq, mappingLaws } from './eq-identify.js';
import { digest, dump, expand, fields, identity, integer, load, number, sha, stringify } from './io.js';
import { run, validate } from './runner.js';
import type { Case, Scalar, State, Stimulus } from './types.js';

interface Experiment { id: string; cases: string[]; parameter: string | null; value: Scalar | null; held_out: boolean }
const designKeys = ['plugin', 'plugin_name', 'native_host', 'effect', 'parameters', 'controls', 'sample_rate', 'channels', 'duration', 'buffer_size', 'timeout_seconds', 'settle_seconds', 'window_ms', 'lag_samples', 'rate_bounds_hz'];
function design(raw: unknown) {
  const o = fields(raw, designKeys, 'effect identification design');
  if (typeof o.plugin !== 'string') throw new Error('Explicit plugin required');
  if (typeof o.effect !== 'string' || !(effectKinds as readonly string[]).includes(o.effect)) throw new Error('Select a supported effect');
  const effect = o.effect as EffectKind, parameters = params(o.parameters);
  if (!Object.keys(parameters).length) throw new Error('Explicit parameters required: isolate the effect and set wet/output controls');
  const modulation = ['phaser', 'flanger', 'chorus', 'tremolo'].includes(effect), duration = number(o.duration ?? (modulation ? 10 : 3), 'duration', .5, 30);
  const settle = number(o.settle_seconds ?? .25, 'settle_seconds', 0, Math.min(20, duration - .1)), window = number(o.window_ms ?? 20, 'window_ms', 1, 2000), lag = integer(o.lag_samples ?? 0, 'lag_samples', -4000000, 4000000);
  const bounds = o.rate_bounds_hz ?? [.2, 10];
  if (!Array.isArray(bounds) || bounds.length !== 2) throw new Error('rate_bounds_hz requires [low,high]');
  const rateBounds: [number, number] = [number(bounds[0], 'low rate', .01, 20), number(bounds[1], 'high rate', .01, 20)];
  if (rateBounds[1] <= rateBounds[0]) throw new Error('rate_bounds_hz must increase');
  let stimuli: Stimulus[];
  if (effect === 'compressor' || effect === 'limiter') stimuli = [-60, -48, -36, -30, -24, -18, -12, -6, -1].map(level_dbfs => ({ kind: 'tone', frequency_hz: 1000, level_dbfs }));
  else if (effect === 'saturation') stimuli = [-24, -12, -1].map(level_dbfs => ({ kind: 'tone', frequency_hz: 997, level_dbfs }));
  else if (modulation) stimuli = [{ kind: 'tone', frequency_hz: 1000, level_dbfs: -18 }];
  else stimuli = [{ kind: 'impulse', at_seconds: .25, level_dbfs: -18 }];
  const experiments: Experiment[] = [], cases: Case[] = [];
  const add = (id: string, overrides: Record<string, Scalar>, parameter: string | null, value: Scalar | null, held_out: boolean) => {
    const ids = stimuli.map((stimulus, i) => { const caseId = `${id}_probe${i}`; cases.push({ id: caseId, stimulus, parameters: overrides }); return caseId; });
    experiments.push({ id, cases: ids, parameter, value, held_out });
  };
  add('anchor', {}, null, null, false);
  const controls = o.controls ?? [], keys = new Set<string>();
  if (!Array.isArray(controls) || controls.length > 3) throw new Error('Select at most 3 controls; total probes must fit 64 cases');
  for (const [index, rawControl] of controls.entries()) {
    const control = fields(rawControl, ['parameter', 'values', 'held_out_indices'], 'effect control');
    if (typeof control.parameter !== 'string' || !control.parameter || keys.has(control.parameter)) throw new Error('Control parameter names must be distinct');
    keys.add(control.parameter);
    if (!Array.isArray(control.values) || control.values.length < 2 || control.values.length > 8 || new Set(control.values).size !== control.values.length) throw new Error('Each control requires 2..8 distinct explicit values');
    const values = control.values, held = control.held_out_indices ?? (values.length >= 4 ? [values.length - 1] : []);
    if (!Array.isArray(held) || new Set(held).size !== held.length || held.some(i => !Number.isInteger(i) || i < 0 || i >= values.length) || values.length - held.length < 2) throw new Error('held_out_indices must leave at least two training values');
    for (const [i, value] of values.entries()) add(`control${index}_value${i}`, params({ [control.parameter]: value }), control.parameter, value as Scalar, held.includes(i));
  }
  if (cases.length > 64) throw new Error('Effect identification exceeds 64 cases; reduce control values');
  const plan = validate({ plugin: o.plugin, plugin_name: o.plugin_name, ...(o.native_host !== undefined ? { native_host: o.native_host } : {}), sample_rate: o.sample_rate, channels: o.channels ?? 1, duration, buffer_size: o.buffer_size, timeout_seconds: o.timeout_seconds, parameters, cases });
  if (plan.duration * plan.sample_rate * plan.channels * cases.length * 8 > 512_000_000) throw new Error('Effect identification exceeds 512 MB raw archive budget');
  return { plan, experiments, effect, settle, window, lag, rateBounds };
}
function readSuite(path: string) {
  const value = fields(load(expand(path)), ['schema_version', 'design'], 'effect identification suite');
  if (value.schema_version !== 1) throw new Error('Unsupported effect identification suite schema');
  return design(value.design);
}
function analyze(suitePath: string, directory: string, output: string, channel: number) {
  const suite = readSuite(suitePath), state = load<State>(join(directory, 'run.json'));
  const stripHost = (plan: typeof suite.plan) => { const { native_host: _host, ...rest } = plan; return rest; };
  suite.plan.plugin = state.identity.path;
  if (digest(stripHost(suite.plan)) !== digest(stripHost(state.spec))) throw new Error('Identification run does not match the suite design');
  const rows = suite.experiments.map(experiment => {
    const observations = experiment.cases.map(id => effectResponse(directory, id, suite.effect, channel, suite.lag, suite.settle, suite.window));
    const readbacks = experiment.cases.map(id => ({ case_id: id, parameters: state.cases.find(c => c.id === id)?.result?.plugin?.parameters ?? null, reported_latency_samples: state.cases.find(c => c.id === id)?.result?.plugin?.reported_latency_samples ?? null }));
    return { ...experiment, readbacks, fit: fitEffect(suite.effect, observations, suite.rateBounds), measurements: observations.map(observationSummary) };
  });
  const mappings = [...new Set(rows.filter(r => r.parameter !== null).map(r => r.parameter!))].map(parameter => {
    const selected = rows.filter(r => r.parameter === parameter), topologyConsistent = new Set(selected.map(r => r.fit.model.family)).size === 1;
    const targets = [...new Set(selected.flatMap(r => Object.keys(r.fit.model).filter(key => key !== 'family')))].map(target => {
      const samples = selected.map(r => ({ value: r.value, held_out: r.held_out, fitted_value: r.fit.accepted && typeof r.fit.model[target] === 'number' ? r.fit.model[target] as number : null }));
      const numeric = samples.filter(s => typeof s.value === 'number' && s.fitted_value !== null).map(s => ({ x: s.value as number, y: s.fitted_value!, held_out: s.held_out }));
      return { target, samples, laws: topologyConsistent && numeric.length === samples.length ? mappingLaws(numeric) : [] };
    });
    return { parameter, topology_consistent: topologyConsistent, targets };
  });
  mkdirSync(dirname(output), { recursive: true }); mkdirSync(output); const report = join(output, 'effects-identification.json');
  dump(report, { status: 'ok', effect: suite.effect, suite_sha256: sha(suitePath), run_sha256: sha(join(directory, 'run.json')), identity: state.identity, channel, analysis: { lag_samples: suite.lag, settle_seconds: suite.settle, window_ms: suite.window, rate_bounds_hz: suite.rateBounds }, rows, mappings, limits: ['Caller explicitly isolates the selected effect. Exact inspected control names and values only; no automatic parameter-role discovery, wet/dry compensation or latency guesses.', 'Models are tested bounded surrogates, not proof of proprietary DSP. Read each fit limits/error_metric/accepted/ambiguous. Dynamics is static only; reverb and phaser/flanger/chorus models summarize decay/carrier behavior, not reconstructive topology.', 'Measurement holdouts exclude points/samples/windows from model fitting, not independent renders. Held-out control values are excluded from mapping-law training; no held-out values means no mapping validation. Local laws must not be extrapolated.'] });
  writeFileSync(join(output, 'EFFECTS_IDENTIFICATION.md'), ['# Measured effect surrogate identification', '', `Effect: ${suite.effect}`, '', 'Best tested models, not recovered proprietary internals. Full samples, residuals, mapping alternatives and limits are in effects-identification.json.', '', '| Experiment | Model | Training error | Held-out error | Metric | Accepted | Ambiguous |', '|---|---|---:|---:|---|---|---|', ...rows.map(r => `| ${r.id} | ${r.fit.model.family} | ${r.fit.training_error} | ${r.fit.held_out_error} | ${r.fit.error_metric} | ${r.fit.accepted} | ${r.fit.ambiguous} |`), '', ...rows[0].fit.limits.map(s => `- ${s}`), '', 'Control mappings are local hypotheses; only explicit held-out controls validate their interpolation.'].join('\n') + '\n', { flag: 'wx' });
  return { status: 'ok', directory: output, report, effect: suite.effect, fits: rows.length, accepted: rows.filter(r => r.fit.accepted).length, ambiguous: rows.filter(r => r.fit.ambiguous).length, mappings: mappings.length, model: rows[0].fit.model };
}
export async function identifyEffects(action: string, raw: unknown) {
  if (!['create', 'run', 'analyze'].includes(action)) throw new Error('Effect identification action must be create, run or analyze');
  const request = fields(raw, action === 'create' ? ['out_file', ...designKeys, 'neutral_parameters', 'bands', 'families', 'stages'] : action === 'run' ? ['suite', 'out_directory', 'native_host', 'channel'] : ['suite', 'run_directory', 'out_directory', 'channel'], 'effect identification');
  if (action !== 'create' && (typeof request.suite !== 'string' || typeof request.out_directory !== 'string')) throw new Error('suite and out_directory required');
  const effect = action === 'create' ? request.effect : load<{ design?: { effect?: unknown } }>(expand(request.suite as string)).design?.effect;
  if (typeof effect !== 'string' || !(effectKinds as readonly string[]).includes(effect)) throw new Error('Select a supported effect');
  if (effect === 'eq' || effect === 'filter') return identifyEq(action, raw);
  if (action === 'create') {
    const o = fields(raw, ['out_file', ...designKeys], 'effect identification create');
    if (typeof o.out_file !== 'string') throw new Error('out_file required');
    const { out_file, ...configuration } = o, suite = design(configuration), path = expand(out_file);
    configuration.plugin = identity(suite.plan.plugin).path;
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, stringify({ schema_version: 1, design: configuration }, 2) + '\n', { flag: 'wx' });
    return { status: 'ok', suite: path, cases: suite.plan.cases.length, configurations: suite.experiments.length, next: 'effects-identify run; inspect names and isolate effect controls first.' };
  }
  const o = fields(raw, action === 'run' ? ['suite', 'out_directory', 'native_host', 'channel'] : ['suite', 'run_directory', 'out_directory', 'channel'], 'effect identification execution');
  if (typeof o.suite !== 'string' || typeof o.out_directory !== 'string') throw new Error('suite and out_directory required');
  const suitePath = expand(o.suite), output = expand(o.out_directory), channel = integer(o.channel ?? 0, 'channel', 0, 1);
  if (action === 'analyze') { if (typeof o.run_directory !== 'string') throw new Error('run_directory required'); return analyze(suitePath, expand(o.run_directory), output, channel); }
  const suite = readSuite(suitePath);
  if (channel >= suite.plan.channels) throw new Error('channel exceeds plan channels');
  if (o.native_host !== undefined) { if (typeof o.native_host !== 'string' || !o.native_host.trim()) throw new Error('native_host must be a non-empty path'); suite.plan.native_host = expand(o.native_host); }
  mkdirSync(dirname(output), { recursive: true }); mkdirSync(output); const plan = join(output, 'plan.json'); dump(plan, suite.plan);
  const state = await run(plan, join(output, 'run'));
  if (state.status !== 'ok') throw new Error(`Effect identification render failed; inspect ${output}; no automatic retry`);
  return analyze(suitePath, join(output, 'run'), join(output, 'analysis'), channel);
}

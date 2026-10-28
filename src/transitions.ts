import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { archive } from './compare.js';
import { params } from './controls.js';
import { analysisWindow } from './audio-error.js';
import { minimize } from './optimize.js';
import { arraySha, digest, dump, expand, fields, load, number, stringify } from './io.js';
import { db } from './measure.js';
import { run, validate } from './runner.js';
import type { Audio, Plan, State } from './types.js';

export async function fitTransition(before: Audio, after: Audio, actual: Audio, sr: number, at: number, window: [number, number]) {
  number(sr, 'sample_rate', 8000, 192000); number(at, 'at_seconds', 0, 30);
  at = Math.round(at * sr) / sr;
  if (!before.length || before.length !== after.length || before.length !== actual.length || before.some((c, i) => c.length !== after[i].length || c.length !== actual[i].length)) throw new Error('Transition endpoint/output shapes must match');
  const w = analysisWindow(actual[0].length, sr, window), split = w.a + Math.floor((w.b - w.a) * .7), span = (w.b - w.a) / sr;
  if (split - w.a < 32 || w.b - split < 32 || at < 0 || at > w.a / sr) throw new Error('Transition fitting needs >=32 training and held-out samples after the event');
  let excitation = 0;
  for (let c = 0; c < before.length; c++) for (let i = w.a; i < w.b; i++) excitation += (after[c][i] - before[c][i]) ** 2;
  if (excitation < 1e-24) throw new Error('Transition endpoints are unexcited/indistinguishable');
  type Kind = 'immediate' | 'delayed_step' | 'first_order' | 'linear_ramp';
  function score(kind: Kind, delay: number, duration: number, start: number, end: number) {
    let error = 0, power = 0;
    for (let i = start; i < end; i++) {
      const t = i / sr - at - delay, mix = t < 0 ? 0 : kind === 'first_order' ? 1 - Math.exp(-t / duration) : kind === 'linear_ramp' ? Math.min(1, t / duration) : 1;
      for (let c = 0; c < actual.length; c++) { const value = before[c][i] + mix * (after[c][i] - before[c][i]); error += (actual[c][i] - value) ** 2; power += actual[c][i] ** 2; }
    }
    return { mse: error / ((end - start) * actual.length), relative_mse: power > 0 ? error / power : null, relative_error_db: power > 0 ? db(Math.sqrt(error / power)) : null, exact_null: error === 0 };
  }
  const alternatives = [{ kind: 'immediate' as Kind, delay_seconds: 0, duration_seconds: 0, training: score('immediate', 0, 0, w.a, split), held_out: score('immediate', 0, 0, split, w.b), evaluations: 1 }];
  for (const kind of ['delayed_step', 'first_order', 'linear_ramp'] as const) {
    const maxDelay = Math.min(.05, span * .25), smooth = kind !== 'delayed_step';
    const search = await minimize({ bounds: smooth ? [[0, maxDelay], [Math.log(1 / sr), Math.log(Math.max(1, span * 3))]] : [[0, maxDelay]], initial: smooth ? [0, Math.log(.01)] : [Math.min(.005, maxDelay)], max_evaluations: smooth ? 64 : 32 }, async p => score(kind, p[0], smooth ? Math.exp(p[1]) : 0, w.a, split).mse);
    const delay = search.best.point[0], duration = smooth ? Math.exp(search.best.point[1]) : 0;
    alternatives.push({ kind, delay_seconds: delay, duration_seconds: duration, training: score(kind, delay, duration, w.a, split), held_out: score(kind, delay, duration, split, w.b), evaluations: search.evaluations });
  }
  alternatives.sort((a, b) => a.training.mse - b.training.mse);
  const best = alternatives[0], held = best.held_out.relative_mse;
  return { best, alternatives, accepted: held !== null && held <= 1e-4, window_seconds: w.seconds, held_out_window_seconds: [split / sr, w.b / sr], limit: 'Fits output interpolation between two fresh-process, fixed-control endpoints, not coefficient smoothing or internal topology. The last 30% of time is held out, not an independent input/render. Residuals expose state/history mismatch; no state-retention/reset law is inferred.' };
}
function transitionSuite(raw: unknown) {
  const o = fields(raw, ['schema_version', 'plan', 'events'], 'transition suite');
  if (o.schema_version !== 1 || !Array.isArray(o.events) || !o.events.length || o.events.length > 16) throw new Error('Invalid transition suite');
  const plan = validate(o.plan);
  const events = o.events.map(value => {
    const e = fields(value, ['id', 'at_seconds', 'before_case', 'after_case', 'case_id'], 'transition event');
    for (const key of ['id', 'before_case', 'after_case', 'case_id']) if (typeof e[key] !== 'string') throw new Error('Invalid transition case ID');
    if (![e.before_case, e.after_case, e.case_id].every(id => plan.cases.some(c => c.id === id))) throw new Error('Unknown transition case ID');
    return { id: e.id as string, at_seconds: number(e.at_seconds, 'at_seconds', .05, plan.duration - .03), before_case: e.before_case as string, after_case: e.after_case as string, case_id: e.case_id as string };
  });
  return { plan, events };
}
function analyze(suitePath: string, runDirectory: string, output: string) {
  const suite = transitionSuite(load(suitePath)), state = load<State>(join(runDirectory, 'run.json'));
  const stripHost = (plan: Plan) => { const { native_host: _host, ...rest } = plan; return rest; };
  suite.plan.plugin = state.identity.path;
  if (digest(stripHost(suite.plan)) !== digest(stripHost(state.spec))) throw new Error('Transition run does not match suite');
  return Promise.all(suite.events.map(async event => {
    const a = archive(runDirectory, event.before_case), b = archive(runDirectory, event.after_case), y = archive(runDirectory, event.case_id);
    if (a.sr !== y.sr || b.sr !== y.sr || arraySha(a.input) !== arraySha(y.input) || arraySha(b.input) !== arraySha(y.input)) throw new Error('Transition endpoints must use exactly identical archived inputs');
    const fit = await fitTransition(a.output, b.output, y.output, y.sr, event.at_seconds, [event.at_seconds, Math.min(suite.plan.duration, event.at_seconds + .3)]);
    return { ...event, fit };
  })).then(rows => {
    mkdirSync(dirname(output), { recursive: true }); mkdirSync(output);
    const report = join(output, 'transitions.json'); dump(report, { status: 'ok', rows, run_directory: runDirectory, state_snapshots: 'Every generated case requests a saved state; see verified case artifacts. These snapshots are evidence, not an inferred implementation of proprietary state.', limits: rows[0].fit.limit });
    return { status: 'ok', report, transitions: rows.length, accepted: rows.filter(r => r.fit.accepted).length, models: rows.map(r => ({ id: r.id, ...r.fit.best, alternatives: undefined })) };
  });
}
export async function transitions(action: string, raw: unknown) {
  if (action === 'create') {
    const o = fields(raw, ['plan_file', 'out_file', 'transitions'], 'transition design');
    if (typeof o.plan_file !== 'string' || typeof o.out_file !== 'string' || !Array.isArray(o.transitions) || !o.transitions.length || o.transitions.length > 16) throw new Error('plan_file, out_file and 1..16 transitions required');
    const plan = validate(load(expand(o.plan_file))), seed = plan.cases[0];
    if (plan.cases.length !== 1 || plan.automation?.length || seed.automation?.length || plan.duration < .1) throw new Error('Transition design needs one controlled stimulus case, no existing automation and >=100 ms duration');
    const events: { id: string; at_seconds: number; before_case: string; after_case: string; case_id: string }[] = [];
    const cases = o.transitions.flatMap(value => {
      const e = fields(value, ['id', 'at_seconds', 'before_parameters', 'after_parameters'], 'transition design item');
      if (typeof e.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(e.id) || events.some(v => v.id === e.id)) throw new Error('Transition IDs must be unique and 1..40 safe characters');
      const before = { ...seed.parameters, ...params(e.before_parameters) }, after = { ...before, ...params(e.after_parameters) }, at = number(e.at_seconds, 'at_seconds', .05, plan.duration - .03);
      if (!Object.keys(after).some(key => after[key] !== before[key])) throw new Error('Transition requires changed parameter values');
      const event = { id: e.id, at_seconds: at, before_case: `${e.id}-before`, after_case: `${e.id}-after`, case_id: `${e.id}-event` }; events.push(event);
      return [{ ...seed, id: event.before_case, parameters: before, save_state: true }, { ...seed, id: event.after_case, parameters: after, save_state: true }, { ...seed, id: event.case_id, parameters: before, save_state: true, automation: [{ time: at, parameters: after }] }];
    });
    const suite = { schema_version: 1, plan: validate({ ...plan, cases }), events }; transitionSuite(suite);
    const path = expand(o.out_file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, stringify(suite, 2) + '\n', { flag: 'wx' });
    return { status: 'ok', suite: path, cases: cases.length, plugins_loaded: 0 };
  }
  if (!['run', 'analyze'].includes(action)) throw new Error('Transition action must be create, run or analyze');
  const o = fields(raw, ['suite', 'out_directory', ...(action === 'run' ? ['native_host'] : ['run_directory'])], 'transition execution');
  if (typeof o.suite !== 'string' || typeof o.out_directory !== 'string') throw new Error('suite and out_directory required');
  const suitePath = expand(o.suite), output = expand(o.out_directory);
  if (action === 'analyze') { if (typeof o.run_directory !== 'string') throw new Error('run_directory required'); return analyze(suitePath, expand(o.run_directory), output); }
  const suite = transitionSuite(load(suitePath));
  if (o.native_host !== undefined) { if (typeof o.native_host !== 'string') throw new Error('native_host must be a path'); suite.plan.native_host = expand(o.native_host); }
  mkdirSync(dirname(output), { recursive: true }); mkdirSync(output); const plan = join(output, 'plan.json'); dump(plan, suite.plan);
  const state = await run(plan, join(output, 'run'));
  if (state.status !== 'ok') throw new Error(`Transition render failed; evidence preserved at ${output}; no automatic retry`);
  return analyze(suitePath, join(output, 'run'), join(output, 'analysis'));
}

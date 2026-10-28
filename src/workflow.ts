import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { digest, dump, expand, fields, object, stringify } from './io.js';
import { inspect, preset, run, validate } from './runner.js';
import { createMatrix } from './matrix.js';
import { compare } from './compare.js';
import { verify } from './verify.js';
import { identifyEffects } from './effects-identify.js';
import { match } from './match.js';
import { transitions } from './transitions.js';
import { exportModel } from './export-model.js';
import { buildHost, juce } from './juce.js';
import { report } from './report.js';

export const workflowOperations = ['inspect', 'plan', 'matrix', 'run', 'compare', 'verify', 'effects-identify.create', 'effects-identify.run', 'effects-identify.analyze', 'match.create', 'match.run', 'match.fit', 'match.optimize', 'transitions.create', 'transitions.run', 'transitions.analyze', 'export-model', 'juce.doctor', 'juce.create', 'juce.build', 'setup-native', 'report'] as const;
const summaryFields = new Set(['kind', 'status', 'directory', 'project_directory', 'report', 'plan', 'suite', 'inspection', 'plugin', 'host', 'native_host', 'manifest', 'cases', 'fits', 'accepted', 'ambiguous', 'sections', 'models', 'transitions', 'completed', 'total', 'total_cases', 'evaluations', 'fit_mse', 'held_out_mse', 'fit_relative_mse', 'held_out_relative_mse', 'optimization_converged', 'held_out_evaluated', 'held_out_informative', 'passed', 'parameter_count', 'metadata_warning_count']);
function compact(result: any) {
  return Object.fromEntries(Object.entries(result).filter(([key, value]) => summaryFields.has(key) && (value === null || typeof value !== 'object')).slice(0, 20));
}
function references(value: unknown, results: Map<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map(v => references(v, results));
  if (!value || typeof value !== 'object') return value;
  const o = value as Record<string, unknown>;
  if ('$ref' in o) {
    if (Object.keys(o).length !== 1 || typeof o.$ref !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)+$/.test(o.$ref)) throw new Error('References require {"$ref":"earlierStep.field[.subfield]"}');
    const [id, ...path] = o.$ref.split('.');
    if (!results.has(id)) throw new Error(`Unknown/forward workflow reference ${id}`);
    let result: any = results.get(id);
    for (const key of path) {
      if (!result || typeof result !== 'object' || !Object.hasOwn(result, key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error(`Missing/unsafe workflow reference ${o.$ref}`);
      result = result[key];
    }
    return result;
  }
  return Object.fromEntries(Object.entries(o).map(([key, v]) => [key, references(v, results)]));
}
async function execute(operation: string, raw: unknown) {
  const args = object(raw, 'step arguments');
  const parts = operation.split('.');
  if (parts[0] === 'effects-identify') return identifyEffects(parts[1], args);
  if (parts[0] === 'match') return match(parts[1], args);
  if (parts[0] === 'transitions') return transitions(parts[1], args);
  if (parts[0] === 'juce') return juce(parts[1], args);
  if (operation === 'setup-native') return buildHost(args);
  if (operation === 'matrix') return createMatrix(args);
  if (operation === 'export-model') return exportModel(args);
  if (operation === 'inspect') {
    const o = fields(args, ['plugin', 'out_directory', 'timeout_seconds', 'plugin_name', 'native_host'], 'inspect step');
    if (typeof o.plugin !== 'string' || typeof o.out_directory !== 'string') throw new Error('inspect requires plugin and out_directory');
    return inspect(o.plugin, expand(o.out_directory), o.timeout_seconds as number ?? 30, o.plugin_name as string | undefined, o.native_host as string | undefined);
  }
  if (operation === 'plan') {
    const { plugin, preset: kind, out_file, ...options } = args;
    if (typeof plugin !== 'string' || typeof out_file !== 'string' || !['effect', 'generator'].includes(String(kind))) throw new Error('plan requires plugin, preset and out_file');
    const spec = validate({ ...preset(plugin, kind as 'effect' | 'generator'), ...options }), target = expand(out_file);
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, stringify(spec, 2) + '\n', { flag: 'wx' });
    return { status: 'ok', plan: target, cases: spec.cases.length };
  }
  if (operation === 'run') {
    const o = fields(args, ['spec_path', 'out_directory', 'native_host'], 'run step');
    if (typeof o.spec_path !== 'string' || typeof o.out_directory !== 'string') throw new Error('run requires spec_path and out_directory');
    const directory = expand(o.out_directory), state = await run(expand(o.spec_path), directory, false, false, o.native_host as string | undefined);
    return { status: state.status, directory, report: join(directory, 'REPORT.md'), completed: state.cases.filter(c => c.status === 'ok').length, total: state.spec.cases.length };
  }
  const { run_directory, out_directory, ...options } = args;
  if (typeof run_directory !== 'string') throw new Error(`${operation} requires run_directory`);
  if (operation === 'report') { fields(args, ['run_directory'], 'report step'); return report(expand(run_directory)); }
  if (typeof out_directory !== 'string') throw new Error(`${operation} requires out_directory`);
  if (operation === 'compare') return compare(expand(run_directory), expand(out_directory), options);
  if (operation === 'verify') return verify(expand(run_directory), expand(out_directory), options);
  throw new Error(`Unsupported workflow operation ${operation}`);
}
/** Runs allowlisted core operations internally; only compact summaries cross the tool boundary. */
export async function workflow(raw: unknown) {
  const o = fields(raw, ['out_directory', 'steps'], 'workflow');
  if (typeof o.out_directory !== 'string' || !Array.isArray(o.steps) || !o.steps.length || o.steps.length > 32) throw new Error('Workflow requires out_directory and 1..32 steps');
  const ids = new Set<string>();
  const steps = o.steps.map(value => {
    const s = fields(value, ['id', 'operation', 'arguments'], 'workflow step');
    if (typeof s.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(s.id) || ids.has(s.id)) throw new Error('Workflow step IDs must be distinct safe identifiers');
    if (!workflowOperations.includes(s.operation as any)) throw new Error(`Operation not allowlisted: ${s.operation}`);
    ids.add(s.id); object(s.arguments, 'step arguments'); return { id: s.id, operation: s.operation as string, arguments: s.arguments };
  });
  const root = expand(o.out_directory); mkdirSync(dirname(root), { recursive: true }); mkdirSync(root);
  const results = new Map<string, unknown>(), manifest = { status: 'running', design_sha256: digest(steps), steps: [] as { id: string; operation: string; status: string; output: string; summary: unknown }[], error: '' }, checkpoint = join(root, 'workflow.json');
  dump(checkpoint, manifest);
  for (const step of steps) {
    const output = join(root, `${step.id}.json`);
    try {
      const args = references(step.arguments, results), result = await execute(step.operation, args);
      dump(output, result);
      if ((result as any).status === 'error' || (result as any).passed === false) throw new Error(`Step ${step.id} failed; details: ${output}`);
      results.set(step.id, result); manifest.steps.push({ id: step.id, operation: step.operation, status: 'ok', output, summary: compact(result) }); dump(checkpoint, manifest);
    } catch (error) {
      manifest.status = 'error'; manifest.error = `${step.id}: ${error instanceof Error ? error.message : String(error)}`;
      manifest.steps.push({ id: step.id, operation: step.operation, status: 'error', output, summary: {} }); dump(checkpoint, manifest);
      throw new Error(`Workflow stopped without retries: ${manifest.error}; checkpoint: ${checkpoint}`);
    }
  }
  manifest.status = 'ok'; dump(checkpoint, manifest);
  return { status: 'ok', report: checkpoint, completed: steps.length, steps: manifest.steps.map(({ id, status, summary }) => ({ id, status, ...Object.fromEntries(Object.entries(summary as object).filter(([, v]) => typeof v === 'number' || typeof v === 'boolean')) })), last_result: compact(results.get(steps.at(-1)!.id)) };
}

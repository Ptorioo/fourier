import { realpathSync, statSync } from 'node:fs';
import { expand, fields, integer, load, number, object } from './io.js';
import type { AutomationEvent, Controls, Scalar } from './types.js';

export function params(value: unknown): Record<string, Scalar> {
  const data = object(value, 'parameters');
  if (Object.keys(data).length > 512 || Object.values(data).some(v => !['string', 'number', 'boolean'].includes(typeof v) || typeof v === 'number' && !Number.isFinite(v))) throw new Error('Parameters require <=512 finite scalar values');
  return data as Record<string, Scalar>;
}
export function controls(value: Record<string, unknown>, duration: number, sr: number): Controls {
  const out: Controls = {};
  if (value.state_file !== undefined) {
    if (typeof value.state_file !== 'string' || !value.state_file) throw new Error('state_file must be a path');
    out.state_file = realpathSync(expand(value.state_file));
    if (!statSync(out.state_file).isFile() || statSync(out.state_file).size > 6 * 1024 * 1024) throw new Error('State snapshot exceeds 6 MiB or is not a file');
  }
  if (value.save_state !== undefined) {
    if (typeof value.save_state !== 'boolean') throw new Error('save_state must be boolean');
    out.save_state = value.save_state;
  }
  if (value.automation !== undefined) {
    if (!Array.isArray(value.automation) || value.automation.length > 256) throw new Error('automation requires <=256 ordered events');
    let previous = -1;
    out.automation = value.automation.map(raw => {
      const event = fields(raw, ['time', 'parameters'], 'automation event'), time = number(event.time, 'automation time', 0, duration), sample = Math.round(time * sr);
      if (sample < previous || sample >= Math.round(duration * sr)) throw new Error('Automation must be ordered and target samples inside the render');
      previous = sample;
      const parameters = params(event.parameters);
      if (!Object.keys(parameters).length) throw new Error('Automation event requires parameters');
      return { time, parameters };
    });
  }
  return out;
}
export function events(automation: AutomationEvent[] = [], sr: number) {
  return automation.map(event => ({ sample: Math.round(event.time * sr), parameters: event.parameters }));
}
export interface Snapshot {
  schema_version: 1; plugin_sha256: string; plugin_name: string; backend: 'juce' | 'typescript';
  sample_rate: number; channels: number; buffer_size: number; parameters: Record<string, Scalar>; data?: string;
}
export function snapshot(path: string, hash: string, backend: string, sr: number, channels: number, buffer: number): Snapshot {
  const s = fields(load(path), ['schema_version', 'plugin_sha256', 'plugin_name', 'backend', 'sample_rate', 'channels', 'buffer_size', 'parameters', 'data'], 'snapshot');
  if (s.schema_version !== 1 || s.plugin_sha256 !== hash || s.backend !== backend || typeof s.plugin_name !== 'string') throw new Error('Incompatible state snapshot identity/schema/backend');
  const rate = integer(s.sample_rate, 'snapshot sample_rate', 8000, 192000), count = integer(s.channels, 'snapshot channels', 1, 2), size = integer(s.buffer_size, 'snapshot buffer_size', 16, 32768);
  if (s.sample_rate !== sr || s.channels !== channels || s.buffer_size !== buffer) throw new Error('State snapshot render settings differ');
  const parameters = params(s.parameters);
  if (backend === 'juce') {
    if (typeof s.data !== 'string' || s.data.length > 5_592_408) throw new Error('Invalid native state bytes');
    const bytes = Buffer.from(s.data, 'base64');
    if (bytes.length > 4 * 1024 * 1024 || bytes.toString('base64') !== s.data) throw new Error('Invalid native state bytes');
  }
  return { schema_version: 1, plugin_sha256: hash, plugin_name: s.plugin_name, backend: backend === 'juce' ? 'juce' : 'typescript', sample_rate: rate, channels: count, buffer_size: size, parameters, ...(typeof s.data === 'string' ? { data: s.data } : {}) };
}

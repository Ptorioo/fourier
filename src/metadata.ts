import type { PluginInfo } from './types.js';

export interface MetadataWarning { parameter: string; code: string; message: string }
// Keep reported keys/readbacks unchanged: ambiguous text must not silently remap a control.
export function parameterWarnings(plugin: PluginInfo): MetadataWarning[] {
  const warnings: MetadataWarning[] = [], ids = new Map<string, string>();
  const add = (parameter: string, code: string, message: string) => warnings.push({ parameter, code, message });
  for (const [key, p] of Object.entries(plugin.parameters)) {
    if (p.raw_value !== undefined && (!Number.isFinite(p.raw_value) || p.raw_value < 0 || p.raw_value > 1)) add(key, 'invalid_normalized_value', 'Native raw_value is outside finite [0,1].');
    if (p.id !== undefined) {
      if (ids.has(p.id)) add(key, 'duplicate_id', `Parameter ID also belongs to ${ids.get(p.id)}.`);
      else ids.set(p.id, key);
    }
    if (p.name !== undefined && !p.name.trim()) add(key, 'empty_name', 'Reported parameter name is empty; use its exact key.');
    if (p.valid_values) {
      if (!p.valid_values.length) add(key, 'empty_enum', 'Reported enumeration is empty.');
      if (new Set(p.valid_values.map(v => `${typeof v}:${v}`)).size !== p.valid_values.length) add(key, 'ambiguous_enum', 'Duplicate enumeration labels cannot identify distinct positions; use inspected normalized numeric values.');
      if (p.valid_values.some(v => typeof v === 'string' && !v.trim())) add(key, 'empty_enum_label', 'Enumeration contains an empty label.');
      if (!p.valid_values_truncated && !p.valid_values.includes(p.value)) add(key, 'enum_readback_mismatch', 'Current readback is absent from the complete enumeration.');
    }
  }
  return warnings;
}

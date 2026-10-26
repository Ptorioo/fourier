import { basename, isAbsolute, join, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { digest, legacyRunFingerprint, load, sha } from './io.js';
import type { Entry, Result, State } from './types.js';

export const safeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
export function verifiedRun(directory: string): State {
  const checkpoint = join(directory, 'run.json'), state = load<State>(checkpoint);
  if (!['measurements', 'wav_analysis'].includes(state.kind)) throw new Error('Unsupported run kind');
  // Historical WAV analyses have no run fingerprint; their case artifacts are still checked.
  if (state.kind !== 'wav_analysis' || state.fingerprint !== undefined) {
    const fingerprint = digest({ spec: state.spec, plugin: state.identity, provenance: state.provenance });
    if (state.fingerprint !== fingerprint && state.fingerprint !== legacyRunFingerprint(checkpoint)) throw new Error('Run fingerprint mismatch');
  }
  if (!['running', 'ok', 'error'].includes(state.status) || new Set(state.cases.map(entry => entry.id)).size !== state.cases.length || state.cases.some(entry => !safeId(entry.id))) throw new Error('Invalid run status or case IDs in checkpoint');
  return state;
}
export function artifactPath(directory: string, name: string): string {
  if (name !== basename(name) || /[\\/]/.test(name) || ['.', '..'].includes(name)) throw new Error('Invalid artifact path');
  const base = realpathSync(directory), path = realpathSync(join(directory, name));
  if (path === base || !path.startsWith(base + sep) || isAbsolute(name)) throw new Error('Artifact escapes case directory');
  return path;
}
export function verifyArtifacts(directory: string, entry: Entry) {
  if (!entry.artifacts || !Object.keys(entry.artifacts).length) throw new Error('Missing artifact hashes');
  for (const [name, expected] of Object.entries(entry.artifacts)) {
    try { if (sha(artifactPath(directory, name)) === expected) continue; } catch { /* Missing or unsafe artifacts also invalidate the checkpoint. */ }
    throw new Error(`Artifact checksum mismatch or missing file: ${entry.id}/${name}`);
  }
}
export function verifiedCase(directory: string, entry: Entry): Result {
  if (!safeId(entry.id)) throw new Error('Invalid case ID in checkpoint');
  if (!['ok', 'error'].includes(entry.status) || entry.result?.status !== entry.status) throw new Error('Case status differs from checkpoint result');
  const required = entry.status === 'ok' ? ['result.json', 'audio.npz', 'traces.json'] : ['result.json'];
  if (required.some(name => !entry.artifacts?.[name])) throw new Error(`Missing required artifact hashes: ${entry.id}`);
  const folder = join(directory, 'cases', entry.id);
  verifyArtifacts(folder, entry);
  const result = load<Result>(artifactPath(folder, 'result.json'));
  if (digest(result) !== digest(entry.result)) throw new Error('Case result differs from checkpoint');
  return result;
}

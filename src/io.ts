import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Audio, Identity } from './types.js';

export const version = '0.1.0';
export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const expand = (path: string) => resolve(path === '~' ? homedir() : path.startsWith('~/') || path.startsWith('~\\') ? join(homedir(), path.slice(2)) : path);
export function object(value: unknown, name = 'value'): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value as Record<string, unknown>;
}
export function fields(value: unknown, allowed: string[], name: string) {
  const data = object(value, name);
  if (Object.keys(data).some(key => !allowed.includes(key))) throw new Error(`Unknown ${name} field`);
  return data;
}
export function number(value: unknown, name: string, lo: number, hi: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < lo || value > hi) throw new Error(`${name} must be a finite number in [${lo}, ${hi}]`);
  return value;
}
export function integer(value: unknown, name: string, lo: number, hi: number): number {
  const n = number(value, name, lo, hi);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer`);
  return n;
}
export function stringify(data: unknown, indent?: number): string {
  return JSON.stringify(data, (_key, value: unknown) => {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Non-finite JSON number');
    return value;
  }, indent);
}
export function dump(path: string, data: unknown) {
  const text = stringify(data, 2) + '\n';
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.fourier-${randomUUID()}.tmp`);
  try { writeFileSync(tmp, text, { flag: 'wx' }); renameSync(tmp, path); }
  finally { rmSync(tmp, { force: true }); }
}
export function load<T = unknown>(path: string): T {
  if (statSync(path).size > 8 * 1024 * 1024) throw new Error('JSON file exceeds 8 MiB guard');
  try { const value: unknown = JSON.parse(readFileSync(path, 'utf8')); stringify(value); return value as T; }
  catch (error) { throw new Error(`Invalid JSON in ${path}: ${error instanceof Error ? error.message : error}`); }
}
export function sha(path: string): string {
  const hash = createHash('sha256'), fd = openSync(path, 'r'), chunk = Buffer.alloc(1024 * 1024);
  try { for (;;) { const n = readSync(fd, chunk); if (!n) break; hash.update(chunk.subarray(0, n)); } }
  finally { closeSync(fd); }
  return hash.digest('hex');
}
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
function sorted(value: unknown): Json {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, sorted(v)]));
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value;
  throw new TypeError('Expected JSON value');
}
export const digest = (data: unknown) => createHash('sha256').update(stringify(sorted(data))).digest('hex');
export function legacyRunFingerprint(path: string): string {
  // Preserve Python's float lexemes (1.0 vs 1) and ensure_ascii encoding in old checkpoints.
  const token = Symbol('number');
  const raw = JSON.parse(readFileSync(path, 'utf8'), (_key: string, value: unknown, context?: { source?: string }) => typeof value === 'number' ? { [token]: context?.source ?? String(value) } : value) as Record<string, unknown>;
  const ascii = (text: string) => JSON.stringify(text).replace(/[\u007f-\uffff]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
  function canonical(value: unknown): string {
    if (value !== null && typeof value === 'object' && token in value) return String(value[token]);
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => ascii(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
    return typeof value === 'string' ? ascii(value) : stringify(value);
  }
  return createHash('sha256').update(canonical({ spec: raw.spec, plugin: raw.identity, provenance: raw.provenance })).digest('hex');
}
export const builtins = ['builtin:gain', 'builtin:delay', 'builtin:clip', 'builtin:synth'];
export function resolvePlugin(value: string): string {
  if (builtins.includes(value)) return value;
  const path = realpathSync(expand(value)), suffix = extname(path).toLowerCase();
  if (!['.vst3', '.component'].includes(suffix)) throw new Error('Only VST3 and macOS Audio Unit plug-ins are supported (not installers or VST2)');
  if (suffix === '.component' && process.platform !== 'darwin') throw new Error('Audio Units require macOS');
  if (process.platform === 'win32' && statSync(path).isDirectory()) {
    const folder = join(path, 'Contents', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-win`);
    const candidates = existsSync(folder) ? readdirSync(folder).filter(name => name.toLowerCase().endsWith('.vst3')) : [];
    if (candidates.length !== 1) throw new Error(`Expected one current-architecture VST3 binary in bundle; found ${candidates.length}`);
    return realpathSync(join(folder, candidates[0]));
  }
  return path;
}
export function sourceHash(): string {
  return digest(Object.fromEntries(readdirSync(join(packageRoot, 'dist')).filter(name => name.endsWith('.js')).sort().map(name => [name, sha(join(packageRoot, 'dist', name))])));
}
export function identity(value: string): Identity {
  const path = resolvePlugin(value);
  if (path.startsWith('builtin:')) return { path, sha256: digest([path, version, sourceHash()]), kind: 'builtin' };
  if (statSync(path).isFile()) return { path, sha256: sha(path), bytes: statSync(path).size, kind: 'binary' };
  const files: { path: string; sha256: string }[] = [];
  let total = 0;
  function walk(folder: string) {
    for (const name of readdirSync(folder).sort()) {
      const file = join(folder, name), info = lstatSync(file);
      if (info.isSymbolicLink()) throw new Error('Symlinks in plug-in bundle require selecting its real executable explicitly');
      if (info.isDirectory()) walk(file);
      else if (info.isFile()) {
        total += info.size;
        if (total > 512 * 1024 * 1024 || files.length >= 8192) throw new Error('Bundle identity exceeds guard; select a native executable instead');
        files.push({ path: file.slice(path.length + 1).split(sep).join('/'), sha256: sha(file) });
      }
    }
  }
  walk(path);
  return { path, sha256: digest(files), bytes: total, kind: 'bundle', files };
}
export function discovery(roots?: string[]) {
  roots ??= process.platform === 'win32' ? [join(process.env.COMMONPROGRAMFILES || 'C:/Program Files/Common Files', 'VST3')] : process.platform === 'darwin' ? ['/Library/Audio/Plug-Ins/VST3', '~/Library/Audio/Plug-Ins/VST3', '/Library/Audio/Plug-Ins/Components', '~/Library/Audio/Plug-Ins/Components'] : ['~/.vst3', '/usr/lib/vst3', '/usr/local/lib/vst3'];
  const found = new Map<string, { path: string; loaded: boolean; resolved?: string; error?: string }>();
  function walk(path: string) {
    if (!existsSync(path)) return;
    if (['.vst3', '.component'].includes(extname(path).toLowerCase())) {
      try { const real = realpathSync(path); found.set(real, { path: real, resolved: resolvePlugin(path), loaded: false }); }
      catch (error) { found.set(path, { path, error: String(error), loaded: false }); }
      if (found.size > 4096) throw new Error('Discovery limit exceeded; use narrower roots');
    } else if (lstatSync(path).isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
  }
  roots.forEach(root => walk(expand(root)));
  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
}
export function readWav(path: string): [Audio, number] {
  if (statSync(path).size > 32 * 1024 * 1024) throw new Error('WAV exceeds file guard');
  const data = readFileSync(path);
  if (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Expected RIFF PCM WAV');
  let channels = 0, width = 0, sr = 0, pcm: Buffer | undefined;
  for (let offset = 12; offset + 8 <= data.length;) {
    const name = data.toString('ascii', offset, offset + 4), size = data.readUInt32LE(offset + 4), start = offset + 8;
    if (start + size > data.length) throw new Error('Truncated WAV chunk');
    if (name === 'fmt ') {
      if (size < 16) throw new Error('Invalid WAV format');
      let format = data.readUInt16LE(start);
      if (format === 0xfffe && size >= 40 && data.readUInt16LE(start + 16) >= 22 && data.readUInt16LE(start + 18) === data.readUInt16LE(start + 14) && data.subarray(start + 24, start + 40).equals(Buffer.from('0100000000001000800000aa00389b71', 'hex'))) format = 1;
      if (format !== 1) throw new Error('Only integer PCM WAV supported, not IEEE-float WAV');
      channels = data.readUInt16LE(start + 2); sr = data.readUInt32LE(start + 4); width = data.readUInt16LE(start + 14) / 8;
      if (data.readUInt16LE(start + 12) !== channels * width) throw new Error('Invalid WAV block alignment');
    }
    if (name === 'data') pcm = data.subarray(start, start + size);
    offset = start + size + (size % 2);
  }
  if (!pcm || ![1, 2].includes(channels) || ![1, 2, 3, 4].includes(width) || sr <= 0 || pcm.length % (channels * width) || pcm.length / width > 4_000_000) throw new Error('WAV guard: 1/2 channels, 8/16/24/32-bit PCM and <=4 million samples');
  const n = pcm.length / (channels * width), audio = Array.from({ length: channels }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) for (let ch = 0; ch < channels; ch++) {
    const offset = (i * channels + ch) * width;
    audio[ch][i] = width === 1 ? (pcm[offset] - 128) / 128 : pcm.readIntLE(offset, width) / 2 ** (width * 8 - 1);
  }
  return [audio, sr];
}
export function preview(path: string, audio: Audio, sr: number): string | null {
  if (audio.some(ch => ch.some(v => Math.abs(v) > 1))) return 'Preview omitted: signal exceeds PCM full scale; unmodified float audio remains in audio.npz';
  const channels = audio.length, n = audio[0].length, data = Buffer.alloc(44 + n * channels * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20);
  data.writeUInt16LE(channels, 22); data.writeUInt32LE(sr, 24); data.writeUInt32LE(sr * channels * 2, 28); data.writeUInt16LE(channels * 2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(data.length - 44, 40);
  for (let i = 0; i < n; i++) for (let ch = 0; ch < channels; ch++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(32767 / 32768, audio[ch][i])) * 32768), 44 + (i * channels + ch) * 2);
  writeFileSync(path, data); return null;
}
export function audioBytes(audio: Audio): Buffer {
  const data = Buffer.alloc(audio.reduce((sum, ch) => sum + ch.length * 4, 0));
  let offset = 0;
  for (const ch of audio) for (const value of ch) { data.writeFloatLE(value, offset); offset += 4; }
  return data;
}
export const arraySha = (audio: Audio) => createHash('sha256').update(audioBytes(audio)).digest('hex');

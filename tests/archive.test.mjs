import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAudio } from '../dist/archive.js';
import { packageRoot } from '../scripts/bridge.mjs';

const fixture = name => join(packageRoot, 'tests', 'fixtures', name);
test('reads independent NumPy compressed stereo and stored mono archives', () => {
  const stereo = loadAudio(fixture('numpy-compressed.npz'));
  assert.equal(stereo.sample_rate, 48000); assert.deepEqual(stereo.input.map(x => [...x]), [[0, .25, -.5, 1], [-1, .5, -.25, 0]]);
  assert.deepEqual(stereo.output.map(x => [...x]), [[0, .125, -.25, .5], [-.5, .25, -.125, 0]]);
  const mono = loadAudio(fixture('numpy-stored.npz'));
  assert.equal(mono.sample_rate, 44100); assert.deepEqual(mono.input.map(x => [...x]), [[0, .25, -.5, 1]]);
});
test('rejects CRC corruption, unsafe names, decompression bombs and truncated directories', t => {
  const dir = mkdtempSync(join(tmpdir(), 'fourier-zip-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = readFileSync(fixture('numpy-compressed.npz')), central = source.readUInt32LE(source.length - 6);
  const check = (name, mutate) => { const bytes = Buffer.from(source), file = join(dir, name); const changed = mutate(bytes) ?? bytes; writeFileSync(file, changed); assert.throws(() => loadAudio(file)); };
  check('crc.npz', b => { b[central + 16] ^= 1; });
  check('name.npz', b => { b.write('../bad.py', central + 46); });
  check('large.npz', b => { b.writeUInt32LE(0x7fffffff, central + 24); });
  check('inflate-limit.npz', b => { b.writeUInt32LE(1, central + 24); });
  check('truncated.npz', b => b.subarray(0, b.length - 10));
  check('bad-directory.npz', b => { b.writeUInt32LE(0, central); });
});

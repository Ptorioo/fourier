import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { packageRoot } from '../scripts/bridge.mjs';

for (const file of ['README.md', 'AGENTS.md', 'skills/audio-analysis/SKILL.md', 'skills/juce-development/SKILL.md']) {
  test(`${file} local links resolve to included files`, () => {
    const path = resolve(packageRoot, file);
    const markdown = readFileSync(path, 'utf8');
    for (const [, target] of markdown.matchAll(/\]\(([^)]+)\)/g)) {
      if (/^(?:[a-z]+:|#)/i.test(target)) continue;
      assert.ok(existsSync(resolve(dirname(path), target.split('#')[0])), `Missing ${file} target: ${target}`);
    }
  });
}

test('npm package includes TypeScript backend, native source, templates and both skills', { skip: !process.env.npm_execpath }, t => {
  const packed = execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: packageRoot, encoding: 'utf8', windowsHide: true, timeout: 60000,
  });
  const manifest = JSON.parse(packed)[0];
  assert.equal(manifest.name, '@ptorioo/fourier');
  const files = new Set(manifest.files.map(file => file.path));
  assert.ok(files.has('AGENTS.md'));
  assert.ok(files.has('README.md'));
  assert.ok(files.has('dist/cli.js'));
  assert.ok(files.has('dist/.build.json'));
  assert.ok(files.has('dist/integrity.js'));
  assert.ok(files.has('scripts/build.mjs'));
  assert.ok(files.has('scripts/test-integration.mjs'));
  assert.ok(files.has('dist/worker.js'));
  assert.ok(files.has('skills/audio-analysis/SKILL.md'));
  assert.ok(files.has('tests/fixtures/numpy-compressed.npz'));
  assert.ok(files.has('src/juce.ts'));
  assert.ok(files.has('native/CMakeLists.txt'));
  assert.ok(files.has('native/main.cpp'));
  assert.ok([...files].every(path => !path.endsWith('.py')));
  assert.ok(files.has('skills/juce-development/SKILL.md'));
  for (const name of ['CMakeLists.txt', 'PluginProcessor.h', 'PluginProcessor.cpp', 'README.md', '.gitignore']) {
    assert.ok(files.has(`templates/juce/${name}.in`), `Missing ${name} template`);
  }
  assert.ok([...files].every(path => !/(^|\/)(__pycache__|build|venv|\.fourier)(\/|$)/.test(path)));
  const production = mkdtempSync(join(tmpdir(), 'fourier-package-'));
  t.after(() => rmSync(production, { recursive: true, force: true }));
  for (const name of files) {
    const target = join(production, name); mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(packageRoot, name), target);
  }
  assert.equal(existsSync(join(production, 'node_modules')), false);
  const doctor = execFileSync(process.execPath, [join(production, 'scripts/fourier.mjs'), 'doctor'], { cwd: production, encoding: 'utf8', timeout: 30000 });
  assert.equal(JSON.parse(doctor).audio_ready, true, 'packed payload works without a TypeScript compiler');
});

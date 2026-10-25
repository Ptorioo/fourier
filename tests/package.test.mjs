import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { packageRoot } from '../scripts/bridge.mjs';

test('npm package includes TypeScript backend, native source, templates and both skills', { skip: !process.env.npm_execpath }, () => {
  const packed = execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: packageRoot, encoding: 'utf8', windowsHide: true, timeout: 60000,
  });
  const manifest = JSON.parse(packed)[0];
  assert.equal(manifest.name, '@ptorioo/fourier');
  const files = new Set(manifest.files.map(file => file.path));
  assert.ok(files.has('dist/cli.js'));
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
});

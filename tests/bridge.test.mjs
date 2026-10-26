import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { runBackend, packageRoot, descendantsOf } from '../scripts/bridge.mjs';

test('descendant lookup includes separate sessions and rejects cycles/unrelated PIDs', () => {
  const table = '100 4\n11 100\n12 11\n88 9\n11 12\nbad row\n-3 100';
  assert.deepEqual(descendantsOf(100, table), [11, 12]);
  assert.deepEqual(descendantsOf(9, table), [88]);
  assert.deepEqual(descendantsOf(100, ''), []);
});
test('doctor runs without loading native plug-ins', async () => {
  const result = await runBackend(['doctor'], { cwd: packageRoot });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).sandbox, false);
});
test('CLI forwards stdin for plans and JUCE projects while preserving validation', t => {
  const dir = mkdtempSync(join(tmpdir(), 'fourier-cli input-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = (args, input) => spawnSync(process.execPath, [join(packageRoot, 'scripts/fourier.mjs'), ...args], {
    cwd: dir, input, encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  const plan = join(dir, 'plan é.json');
  const initialized = cli(['init', '--plugin', 'builtin:gain', '--out', plan, '--options-stdin'], JSON.stringify({ duration: .25, parameters: { gain_db: -6 } }));
  assert.equal(initialized.status, 0, initialized.stdout + initialized.stderr);
  assert.equal(JSON.parse(readFileSync(plan, 'utf8')).parameters.gain_db, -6);
  const project = join(dir, 'project é');
  const created = cli(['juce', 'create', '--options-stdin'], JSON.stringify({ project_directory: project, name: 'CliFixture', kind: 'effect', manufacturer_code: 'Test', plugin_code: 'Clif' }));
  assert.equal(created.status, 0, created.stdout + created.stderr);
  assert.ok(existsSync(join(project, 'PluginProcessor.cpp')));
  const invalidPlan = join(dir, 'invalid.json');
  for (const [input, error] of [['', /Invalid tool options/], ['{broken', /Invalid tool options/], ['{"extra":true}', /Unknown/], [' '.repeat(1_000_001), /1,000,000-byte limit/]]) {
    const result = cli(['init', '--plugin', 'builtin:gain', '--out', invalidPlan, '--options-stdin'], input);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, error);
    assert.equal(existsSync(invalidPlan), false);
  }
  const doctor = cli(['doctor'], undefined);
  assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
  assert.equal(JSON.parse(doctor.stdout).audio_ready, true);
});
test('arguments are not interpreted as shell commands', async () => {
  const result = await runBackend(['doctor; echo NOT_A_SHELL'], { cwd: packageRoot });
  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /Unknown command/);
});
test('required integration command fails instead of skipping without a JUCE checkout', () => {
  const result = spawnSync(process.execPath, [join(packageRoot, 'scripts/test-integration.mjs')], {
    env: { ...process.env, FOURIER_JUCE_PATH: '' }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 1); assert.match(result.stderr, /Required integration suite needs FOURIER_JUCE_PATH/);
});
test('already-aborted operations do not launch', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runBackend(['doctor'], { signal: controller.signal }), /cancelled before launch/);
});
test('cancellation terminates an active analysis process tree', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'fourier-cancel-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const spec = join(dir, 'plan.json'), out = join(dir, 'run');
  writeFileSync(spec, JSON.stringify({ plugin: 'builtin:gain', duration: 30, cases: [{ id: 'noise', stimulus: { kind: 'noise' } }] }));
  const controller = new AbortController();
  const running = runBackend(['run', '--spec', spec, '--out', out], { cwd: packageRoot, signal: controller.signal });
  const deadline = Date.now() + 10000;
  while (!existsSync(join(out, 'cases', 'noise', 'request.json')) && Date.now() < deadline) await sleep(10);
  controller.abort(); const result = await running;
  assert.match(result.reason, /process tree terminated/); assert.notEqual(result.code, 0);
});

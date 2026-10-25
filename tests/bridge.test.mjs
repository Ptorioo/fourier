import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
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
test('arguments are not interpreted as shell commands', async () => {
  const result = await runBackend(['doctor; echo NOT_A_SHELL'], { cwd: packageRoot });
  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /Unknown command/);
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

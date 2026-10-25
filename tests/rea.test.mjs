import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callRea, normalizeTool, saveReaEvidence } from '../scripts/rea.mjs';

test('REA allowlist refuses scripts, patches and arbitrary names', () => {
  assert.equal(normalizeTool('binary_session'), 'rea_binary_session');
  for (const tool of ['rea_script_tool', 'rea_patch_binary', 'rea_annotate_native_function', 'bash']) assert.throws(() => normalizeTool(tool), /allowlist/);
});
test('REA calls go through Pi nested tools and retain the calling signal', async () => {
  const signal = new AbortController().signal;
  const ctx = { tools: [{ name: 'mcp' }], executeTool: async (name, args, options) => {
    assert.equal(name, 'mcp'); assert.equal(args.tool, 'rea_binary_session'); assert.equal(args.server, 'rea'); assert.equal(options.signal, signal);
    return { isError: false, result: { content: [{ type: 'text', text: 'fixture' }] } };
  } };
  assert.equal((await callRea(ctx, 'call', 'binary_session', {}, signal)).content[0].text, 'fixture');
});
test('a failed MCP call is not retried or reported as success', async () => {
  let count = 0;
  const ctx = { tools: [{ name: 'mcp' }], executeTool: async () => { count++; return { isError: true, result: { content: [{ type: 'text', text: 'permission blocked' }] } }; } };
  await assert.rejects(callRea(ctx, 'call', 'binary_session'), /permission blocked/);
  assert.equal(count, 1);
});
test('REA discovery works without assuming a tool catalog', async () => {
  const ctx = { tools: [{ name: 'mcp' }], executeTool: async (name, args) => {
    assert.deepEqual(args, { server: 'rea' });
    return { content: [{ type: 'text', text: 'current catalog' }] };
  } };
  assert.equal((await callRea(ctx, 'discover')).content[0].text, 'current catalog');
});
test('missing REA does not turn into another execution backend', async () => {
  await assert.rejects(callRea({ tools: [], executeTool: async () => assert.fail() }, 'call', 'binary_session'), /not connected/);
  await assert.rejects(callRea({}, 'call', 'binary_session'), /Pi 1.4/);
});
test('direct REA tools are supported when the gateway is absent', async () => {
  const ctx = { tools: [{ name: 'rea_binary_session' }], executeTool: async (name) => {
    assert.equal(name, 'rea_binary_session'); return { content: [{ type: 'text', text: 'direct' }] };
  } };
  assert.equal((await callRea(ctx, 'call', 'binary_session')).content[0].text, 'direct');
});
test('saved evidence is complete, bounded and marked untrusted/unverified', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fourier-rea-'));
  try {
    const path = await saveReaEvidence(directory, 'rea_binary_session', {}, { content: [] });
    const doc = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(doc.source, 'REA MCP'); assert.match(doc.interpretation, /Untrusted/);
    await assert.rejects(saveReaEvidence(directory, 'rea_binary_session', {}, { huge: 'x'.repeat(2 * 1024 * 1024) }), /guard/);
    assert.equal((await readdir(directory)).length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

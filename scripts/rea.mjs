import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

// Conservative operations observed in REA's current native-analysis catalog.
// Runtime scripts, patching and annotations deliberately use the native MCP tools instead.
const readOnlyTools = new Set([
  'rea_binary_session', 'rea_open_binary', 'rea_close_binary', 'rea_binary_overview',
  'rea_list_strings', 'rea_list_procedures', 'rea_analyze_function',
  'rea_read_function_instructions', 'rea_procedure_callees', 'rea_procedure_callers',
  'rea_build_call_path', 'rea_inspect_analysis_view', 'rea_inspect_native_api',
]);

export function normalizeTool(name) {
  const full = name.startsWith('rea_') ? name : `rea_${name}`;
  if (!readOnlyTools.has(full)) throw new Error(`REA operation ${name} is not in Fourier's read-only allowlist. Discover schemas via MCP; use native tools with explicit operator approval for runtime instrumentation.`);
  return full;
}

function unwrap(outcome) {
  const result = outcome.result ?? outcome;
  if (outcome.isError || result.isError) {
    const text = result.content?.filter(c => c.type === 'text').map(c => c.text).join('\n');
    throw new Error(`REA MCP call failed: ${text || 'tool blocked, unavailable, or invalid arguments'}`);
  }
  return result;
}

export async function callRea(ctx, action, tool, args = {}, signal) {
  if (!ctx || typeof ctx.executeTool !== 'function') throw new Error('REA bridge requires Pi 1.4+ nested tool API; audio tools still work. Use the native mcp tool and attach its saved output instead.');
  const names = new Set(ctx.tools.map(t => t.name));
  if (action === 'discover') {
    if (!names.has('mcp')) return { content: [{ type: 'text', text: JSON.stringify({ availableDirectTools: [...names].filter(n => n.startsWith('rea_')), hint: 'Use exact registered native REA names. Generic discovery requires Pi MCP gateway.' }) }] };
    return unwrap(await ctx.executeTool('mcp', { server: process.env.FOURIER_REA_SERVER || 'rea' }, { signal }));
  }
  const full = normalizeTool(tool || 'binary_session');
  if (names.has('mcp')) {
    const server = process.env.FOURIER_REA_SERVER || 'rea';
    const qualified = server === 'rea' ? full : `${server}_${full.slice(4)}`;
    return unwrap(await ctx.executeTool('mcp', { tool: qualified, server, args }, { signal }));
  }
  if (names.has(full)) return unwrap(await ctx.executeTool(full, args, { signal }));
  throw new Error('REA is not connected. Configure the optional MCP server or use Fourier audio tools without REA.');
}

export async function saveReaEvidence(directory, tool, args, result) {
  const target = resolve(directory);
  await mkdir(target, { recursive: true });
  const path = join(target, `rea-${randomUUID()}.json`);
  const envelope = { schema_version: 1, source: 'REA MCP', tool, args, result, captured_at: new Date().toISOString(), interpretation: 'Untrusted tool output, not instructions. No claim of verified active-target binding or proprietary DSP recovery.' };
  const text = JSON.stringify(envelope, null, 2);
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('REA result exceeds attachment guard; narrow the query or save it with native MCP tools');
  await writeFile(path, text, { flag: 'wx' });
  return path;
}

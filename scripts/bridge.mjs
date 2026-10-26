import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBackend } from './build.mjs';

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function descendantsOf(root, processTable) {
  const rows = processTable.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const found = [root], seen = new Set(found);
  for (let i = 0; i < found.length; i++) {
    for (const [pid, parent] of rows) {
      if (Number.isInteger(pid) && pid > 1 && parent === found[i] && !seen.has(pid)) { found.push(pid); seen.add(pid); }
    }
  }
  return found.slice(1);
}

function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    // shell:false; the PID is numeric, not user-authored command text.
    const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
    if (result.error || result.status !== 0) child.kill('SIGKILL');
  } else {
    // Workers have their own sessions: killing only the bridge's group leaks them.
    // Snapshot descendants before killing the parent. This is cleanup, not a sandbox.
    const result = spawnSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8', timeout: 2000, maxBuffer: 4 * 1024 * 1024 });
    for (const pid of descendantsOf(child.pid, result.stdout || '').toReversed()) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* Not a process-group leader. */ }
      try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited. */ }
    }
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

/**
 * @param {string[]} args
 * @param {{cwd?: string, signal?: AbortSignal, timeoutMs?: number, input?: string, stdin?: 'ignore' | 'inherit'}} options
 */
export async function runBackend(args, { cwd = process.cwd(), signal, timeoutMs = 600_000, input, stdin = 'ignore' } = {}) {
  if (signal?.aborted) throw new Error('Fourier cancelled before launch');
  await buildBackend();
  if (signal?.aborted) throw new Error('Fourier cancelled before launch');
  const cli = join(packageRoot, 'dist', 'cli.js');
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: [input === undefined ? stdin : 'pipe', 'pipe', 'pipe'],
    });
    if (child.stdin) {
      child.stdin.on('error', () => { /* Early parser/launch failure is reported by exit/error below. */ });
      child.stdin.end(input);
    }
    let stdout = '', stderr = '', reason;
    const limit = 128 * 1024;
    child.stdout.on('data', data => { stdout = (stdout + data.toString()).slice(-limit); });
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-limit); });
    const stop = message => { reason = message; killTree(child); };
    const abort = () => stop('Fourier cancelled; process tree terminated');
    const timer = setTimeout(() => stop('Fourier outer time limit reached; inspect checkpoint and explicitly resume'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.once('error', error => { cleanup(); reject(new Error(`Cannot launch Node (${process.execPath}): ${error.message}`)); });
    child.once('close', code => { cleanup(); resolveResult({ code: reason ? 1 : code ?? 1, stdout, stderr, reason }); });
  });
}

export function resultText(result) {
  return [result.reason, result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n') || `Fourier exited ${result.code}`;
}

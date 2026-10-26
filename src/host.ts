import { spawnSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expand, object, packageRoot, sha } from './io.js';

export type HostFeature = 'inspect' | 'render' | 'state' | 'automation';
export function nativeHost(explicit?: string): string {
  const path = explicit ?? process.env.FOURIER_NATIVE_HOST ?? join(packageRoot, 'native', 'build', 'fourier-host' + (process.platform === 'win32' ? '.exe' : ''));
  if (typeof path !== 'string' || !path.trim()) throw new Error('native_host must be a non-empty executable path');
  try { const real = realpathSync(expand(path)); if (statSync(real).isFile()) return real; } catch { /* Report the selected path, never fall back to another helper. */ }
  throw new Error(`Native host not found: ${path}. Build with setup-native --juce PATH, pass native_host/--native-host, or set FOURIER_NATIVE_HOST. Built-ins and WAV analysis need no helper.`);
}
export function checkHost(explicit?: string, required: HostFeature[] = ['inspect', 'render']) {
  const path = nativeHost(explicit), hash = sha(path);
  const result = spawnSync(path, ['--capabilities'], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`Native host capability check failed for ${path}: ${result.error?.message ?? `exit ${result.status}`}. Rebuild the helper from current Fourier source; no plug-in was loaded.`);
  let data;
  try { data = object(JSON.parse(result.stdout), 'host capabilities'); }
  catch { throw new Error(`Invalid capability response from ${path}; rebuild the helper from current Fourier source`); }
  if (data.host !== 'fourier-host' || data.protocol_version !== 1) throw new Error(`Incompatible native host protocol at ${path}; rebuild the helper from current Fourier source`);
  const raw = object(data.capabilities, 'host capability flags');
  const capabilities = { inspect: raw.inspect === true, render: raw.render === true, state: raw.state === true && data.render_controls_version === 1, automation: raw.automation === true && data.render_controls_version === 1 };
  const missing = required.filter(key => !capabilities[key]);
  if (missing.length) throw new Error(`Native host ${path} lacks required capabilities: ${missing.join(', ')}; rebuild the helper from current Fourier source`);
  if (sha(path) !== hash) throw new Error('Native host changed during capability check');
  return { path, sha256: hash, protocol_version: 1, render_controls_version: data.render_controls_version === 1 ? 1 : null, capabilities };
}
export function hostDoctor(explicit?: string) {
  const selection = explicit !== undefined ? 'explicit' : process.env.FOURIER_NATIVE_HOST !== undefined ? 'environment' : 'package';
  try {
    const host = checkHost(explicit, []);
    return { plugins_ready: host.capabilities.inspect && host.capabilities.render, state_ready: host.capabilities.state, automation_ready: host.capabilities.automation, native_host: host.path, host_selection: selection, host, host_error: null };
  } catch (error) {
    return { plugins_ready: false, state_ready: false, automation_ready: false, native_host: null, host_selection: selection, host: null, host_error: error instanceof Error ? error.message : String(error) };
  }
}

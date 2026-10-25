#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { packageRoot } from './bridge.mjs';
if (process.argv.length > 2) {
  console.error('Usage: npm run setup. For native hosting: npm run setup:native -- --juce /path/to/JUCE [--generator NAME]');
  process.exitCode = 2;
} else {
  const result = spawnSync(process.execPath, [join(packageRoot, 'node_modules/typescript/bin/tsc'), '-p', join(packageRoot, 'tsconfig.build.json')], { cwd: packageRoot, stdio: 'inherit', windowsHide: true });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
  if (process.exitCode === 0) console.log('TypeScript backend ready; no Python or audio device needed. Native VST3/AU hosting is optional: npm run setup:native -- --juce /path/to/JUCE');
}

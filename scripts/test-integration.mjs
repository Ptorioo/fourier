import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { packageRoot } from './bridge.mjs';

if (!process.env.FOURIER_JUCE_PATH || !existsSync(join(process.env.FOURIER_JUCE_PATH, 'CMakeLists.txt'))) {
  console.error('Required integration suite needs FOURIER_JUCE_PATH pointing to a trusted local JUCE checkout, a compiler developer shell, and the current native host (npm run setup:native). No SDK is downloaded.');
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, ['--test', 'tests/pi-loader.test.mjs'], {
    cwd: packageRoot, stdio: 'inherit', env: { ...process.env, FOURIER_INTEGRATION: '1' },
  });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
}

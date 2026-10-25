#!/usr/bin/env node
import { runBackend, resultText } from './bridge.mjs';
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
try {
  const result = await runBackend(process.argv.slice(2), { signal: controller.signal });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.reason) process.stderr.write(resultText({ ...result, stdout: '', stderr: '' }) + '\n');
  process.exitCode = result.code;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

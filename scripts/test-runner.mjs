import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const mode = process.argv[2];
if (mode !== undefined && mode !== '--live' && mode !== '--model') throw new Error('Unknown test mode');
const files = mode === '--model' ? ['test/real-model.test.ts']
  : mode === '--live' ? ['test/live-pi.test.ts']
  : (await readdir('test')).filter(f => f.endsWith('.test.ts')).sort().map(f => join('test', f));
const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...files], {
  stdio: 'inherit', env: { ...process.env, ...(mode ? { [mode === '--model' ? 'PI_ACP_MODEL_TESTS' : 'PI_ACP_LIVE_TESTS']: '1' } : {}) },
});
child.once('error', () => { process.exitCode = 1; });
child.once('close', code => { process.exitCode = code ?? 1; });

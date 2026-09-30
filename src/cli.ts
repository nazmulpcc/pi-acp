#!/usr/bin/env node
import { Readable, Writable } from 'node:stream';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import { Adapter } from './adapter.js';
import { Storage, agentDirectory, expandPath } from './sessions/storage.js';
import { limits } from './limits.js';

async function main(): Promise<void> {
  let executable = 'pi';
  let sessionDir: string | undefined;
  let trust: 'approve' | 'no-approve' | undefined;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--version') { process.stdout.write('0.1.0\n'); return; }
    if (arg === '--help') {
      process.stdout.write('airterm-pi-acp: ACP v1 stdio adapter for Pi 0.99.1\n\n--pi <executable>       Installed Pi executable (default: pi on PATH)\n--session-dir <path>    Explicit Pi session storage override\n--approve              Trust project resources for this process\n--no-approve           Skip trust-gated project resources\n--version              Print adapter version\n--help                 Show this help\n'); return;
    }
    if (arg === '--pi' || arg === '--session-dir') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--pi') executable = value; else sessionDir = expandPath(value);
    } else if (arg === '--approve' || arg === '--no-approve') {
      if (trust) throw new Error('Specify at most one project trust override');
      trust = arg === '--approve' ? 'approve' : 'no-approve';
    } else throw new Error(`Unknown adapter option: ${arg}`);
  }
  const diagnostic = (message: string) => {
    // Only bounded adapter-authored messages; no Pi stderr or payload logging.
    process.stderr.write(`[pi-acp] ${message.slice(0, 256)}\n`);
  };
  const adapter = new Adapter({ executable, storage: new Storage(agentDirectory(), sessionDir), diagnostic, ...(trust ? { trust } : {}) });
  // Node and DOM stream declarations differ structurally; the runtime bridge is standard.
  const input = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
  const connection = adapter.app.connect(ndJsonStream(Writable.toWeb(process.stdout), input, { maxMessageBytes: limits.recordBytes }));
  const stop = () => { connection.close(); void adapter.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  process.stdout.once('error', stop);
  try { await connection.closed; }
  finally {
    await adapter.close();
    process.off('SIGINT', stop); process.off('SIGTERM', stop); process.stdout.off('error', stop);
  }
}
void main().catch(() => { process.stderr.write('[pi-acp] Adapter startup failed; use --help to check options\n'); process.exitCode = 1; });

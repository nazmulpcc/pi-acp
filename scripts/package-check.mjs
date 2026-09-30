// Verify the published artifact from a clean directory, through the public CLI.
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import crossSpawn from 'cross-spawn';
import assert from 'node:assert/strict';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// cross-spawn handles npm command shims on Windows without interpolated shell text.
function commandRun(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const process = crossSpawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    process.stdout.on('data', chunk => { out += chunk; }); process.stderr.on('data', chunk => { err += chunk; });
    process.on('error', reject); process.on('close', code => code ? reject(new Error(err)) : resolve(out));
  });
}
const npmRun = (args, cwd) => commandRun(npm, args, cwd);
const root = await mkdtemp(join(tmpdir(), 'pi-acp-pack-'));
try {
  const project = join(root, 'clean-project'); const workspace = join(root, 'workspace'); const agentDir = join(root, 'agent');
  await mkdir(project); await mkdir(workspace); await mkdir(agentDir);
  await writeFile(join(project, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  const dry = JSON.parse(await npmRun(['pack', '--dry-run', '--json', '--workspaces=false'], process.cwd()))[0];
  for (const name of ['dist/cli.js', 'LICENSE', 'NOTICE', 'README.md', 'docs/index.md']) assert.ok(dry.files.some(f => f.path === name), `Missing packed ${name}`);
  assert.ok(!dry.files.some(f => f.path.startsWith('test/') || f.path.startsWith('node_modules/') || f.path.includes('PI_ACP_HANDOFF')));
  const packed = JSON.parse(await npmRun(['pack', '--json', '--workspaces=false', '--pack-destination', root], process.cwd()))[0];
  await npmRun(['install', '--ignore-scripts', '--workspaces=false', join(root, packed.filename)], project);
  const cli = join(project, 'node_modules', '.bin', process.platform === 'win32' ? 'airterm-pi-acp.cmd' : 'airterm-pi-acp');
  const version = await commandRun(cli, ['--version'], workspace); assert.equal(version.trim(), '0.1.0');
  // Fake Pi shim tests installed-executable discovery on all CI platforms.
  const fixture = resolve('test/fixtures/fake-pi.mjs');
  const shim = join(root, process.platform === 'win32' ? 'fake-pi.cmd' : 'fake-pi');
  await writeFile(shim, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
    : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${fixture.replaceAll("'", "'\\''")}' "$@"\n`);
  if (process.platform !== 'win32') await chmod(shim, 0o755);
  const pidFile = join(root, 'owned-pi.pid');
  const sessionDir = join(root, 'sessions');
  const child = crossSpawn(cli, ['--pi', shim, '--session-dir', sessionDir], { cwd: workspace,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_ACP_FIXTURE_PID_FILE: pidFile }, stdio: 'pipe' });
  const exited = new Promise((resolve, reject) => { child.once('close', code => resolve(code)); child.once('error', reject); });
  let diagnostics = ''; child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-8192); });
  let pendingWireBytes = 0; let maxWireBytes = 0;
  child.stdout.on('data', chunk => {
    for (const byte of chunk) {
      pendingWireBytes++;
      if (byte === 10) { maxWireBytes = Math.max(maxWireBytes, pendingWireBytes); pendingWireBytes = 0; }
    }
  });
  const app = client({ name: 'packed-artifact-client' });
  const updates = [];
  app.onNotification(methods.client.session.update, ctx => { updates.push(ctx.params); });
  app.onRequest(methods.client.elicitation.create, () => ({ action: 'accept', content: { answer: 'packed answer' } }));
  const connection = app.connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
  const timer = setTimeout(() => { child.kill('SIGKILL'); }, 20_000);
  try {
    const api = connection.agent;
    await api.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { elicitation: { form: {} } } });
    const session = await api.request('session/new', { cwd: workspace, mcpServers: [] });
    for (const text of ['unicode', '/question', 'tools', 'large-tools']) {
      const result = await api.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text }] });
      assert.equal(result.stopReason, 'end_turn');
    }
    assert.ok(updates.some(n => n.update.sessionUpdate === 'agent_message_chunk' && n.update.content.text === 'packed answer'));
    assert.ok(updates.some(n => n.update.sessionUpdate === 'tool_call_update' && n.update.title === 'write' && n.update.rawOutput?.truncated === true));
    await api.request('session/close', { sessionId: session.sessionId });
    const sessionPath = join(sessionDir, `${session.sessionId}.jsonl`);
    const stored = (await readFile(sessionPath, 'utf8')).trim().split('\n').map(JSON.parse);
    let parentId = stored.at(-1).id;
    const records = [];
    for (let i = 0; i < 24; i++) for (const message of [
      { role: 'user', content: `packed-history-${i}` },
      { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(600 * 1024) }], stopReason: 'stop' },
    ]) {
      const id = `packed-${records.length}`;
      records.push({ type: 'message', id, parentId, timestamp: '', message }); parentId = id;
    }
    await appendFile(sessionPath, records.map(r => JSON.stringify(r) + '\n').join(''));
    const loaded = await api.request('session/load', { sessionId: session.sessionId, cwd: workspace, mcpServers: [] });
    assert.deepEqual(loaded._meta, { 'com.airterm/pi-acp': { historyTruncated: true } });
    assert.ok(updates.some(n => n.update.sessionUpdate === 'user_message_chunk' && n.update.content.text === 'packed-history-23'));
    assert.equal((await api.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'normal' }] })).stopReason, 'end_turn');
    const pid = Number(await readFile(pidFile, 'utf8'));
    const beforeEOF = updates.length;
    const abandoned = api.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'wait' }] }).catch(() => {});
    const startedDeadline = Date.now() + 3000;
    while (!updates.slice(beforeEOF).some(n => n.update.sessionUpdate === 'agent_message_chunk')) {
      assert.ok(Date.now() < startedDeadline, 'EOF test prompt did not start');
      await new Promise(r => setTimeout(r, 10));
    }
    // EOF must clean up this loaded Pi process, including its active prompt.
    child.stdin.end();
    assert.equal(await exited, 0, diagnostics);
    await abandoned;
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.ok(maxWireBytes <= 512 * 1024, `Oversized fixture wire event: ${maxWireBytes}`);
  } finally { clearTimeout(timer); connection.close(); if (child.exitCode === null) child.kill('SIGKILL'); }
  console.log('Packed artifact: clean install, questions/tools, bounded large-history restore/continue and EOF cleanup passed.');
} finally { await rm(root, { recursive: true, force: true }); }

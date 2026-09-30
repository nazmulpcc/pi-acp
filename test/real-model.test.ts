import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, chmod, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { client, methods, ndJsonStream, PROTOCOL_VERSION, type SessionNotification } from '@agentclientprotocol/sdk';
import { agentDirectory } from '../src/sessions/storage.js';

// Opt-in: this test incurs provider usage and reads existing Pi credentials.
// Credentials are copied privately to a temporary Pi directory, never printed.
test('public CLI with zai/glm-5.3-flash: tools, native input, restart and cancellation', {
  skip: process.env.PI_ACP_MODEL_TESTS !== '1', timeout: 180_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-acp-model-'));
  const cwd = join(root, 'workspace'); const agentDir = join(root, 'agent');
  await mkdir(cwd); await mkdir(agentDir, { mode: 0o700 });
  for (const file of ['auth.json', 'models.json']) {
    try { await copyFile(join(agentDirectory(), file), join(agentDir, file)); await chmod(join(agentDir, file), 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
    extensions: [resolve('test/fixtures/real-model-extension.js')], skills: [], promptTemplates: [],
    defaultProvider: 'zai', defaultModel: 'glm-5.3-flash', defaultThinkingLevel: 'low',
  }));
  await writeFile(join(cwd, 'sample.txt'), 'before\n');
  const updates: SessionNotification[] = [];
  const start = () => {
    const child = spawn(process.execPath, [resolve('dist/cli.js'), '--no-approve'], {
      cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, stdio: 'pipe',
    });
    const exited = new Promise<number | null>((r, reject) => { child.once('close', r); child.once('error', reject); });
    child.stderr.on('data', () => {});
    const app = client({ name: 'real-model-acceptance-client' });
    app.onNotification(methods.client.session.update, c => { updates.push(c.params); });
    app.onRequest(methods.client.elicitation.create, () => ({ action: 'accept', content: { answer: 'ACP-REAL-ANSWER' } }));
    const connection = app.connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>));
    return { child, connection, api: connection.agent, stop: async () => { child.stdin.end(); assert.equal(await exited, 0); connection.close(); } };
  };
  let h = start();
  try {
    const initialize = () => h.api.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { elicitation: { form: {} } } });
    await initialize();
    const session = await h.api.request('session/new', { cwd, mcpServers: [] });
    const model = session.configOptions?.find(o => o.id === 'model');
    assert.equal(model?.currentValue, JSON.stringify(['zai', 'glm-5.3-flash']));
    const prompt = (text: string) => h.api.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text }] });
    assert.equal((await prompt('This is an adapter acceptance test in a temporary workspace. Use read to read sample.txt, write to create created.txt containing exactly created followed by a newline, edit to replace before with after in sample.txt, and bash to run printf ACP-REAL-OUTPUT. Call acceptance_question and include its returned token in your final response. Do every requested tool operation, using those named tools, then stop.')).stopReason, 'end_turn');
    assert.equal(await readFile(join(cwd, 'sample.txt'), 'utf8'), 'after\n');
    assert.equal(await readFile(join(cwd, 'created.txt'), 'utf8'), 'created\n');
    const calls = updates.map(n => n.update).filter(u => u.sessionUpdate === 'tool_call');
    for (const name of ['read', 'write', 'edit', 'bash', 'acceptance_question']) assert.ok(calls.some(c => c.name === name), `Missing ${name}`);
    assert.ok(updates.some(n => n.update.sessionUpdate === 'tool_call_update' && JSON.stringify(n.update.content ?? []).includes('ACP-REAL-ANSWER')));
    const competitor = start();
    try {
      await competitor.api.request('initialize', { protocolVersion: PROTOCOL_VERSION });
      await assert.rejects(competitor.api.request('session/load', { sessionId: session.sessionId, cwd, mcpServers: [] }), /already owned/);
      await competitor.stop();
    } finally { competitor.connection.close(); competitor.child.kill('SIGKILL'); }
    const visible = updates.filter(n => ['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk'].includes(n.update.sessionUpdate));
    const ids = [...new Set(visible.flatMap(n => 'messageId' in n.update ? [n.update.messageId] : []))];
    await h.stop(); updates.length = 0;
    h = start(); await initialize();
    await h.api.request('session/load', { sessionId: session.sessionId, cwd, mcpServers: [] });
    assert.deepEqual([...new Set(updates.flatMap(n => 'messageId' in n.update ? [n.update.messageId] : []))], ids);
    const followupStart = updates.length;
    assert.equal((await prompt('Without tools, state the token returned by acceptance_question in our previous turn.')).stopReason, 'end_turn');
    assert.match(updates.slice(followupStart).map(n => n.update.sessionUpdate === 'agent_message_chunk' && n.update.content.type === 'text' ? n.update.content.text : '').join(''), /ACP-REAL-ANSWER/);
    const beforeCancel = updates.length;
    const pending = prompt('Use bash to execute sleep 30 in this temporary workspace, then report completion.');
    const deadline = Date.now() + 45_000;
    while (!updates.slice(beforeCancel).some(n => n.update.sessionUpdate === 'tool_call_update' && n.update.status === 'in_progress')) {
      assert.ok(Date.now() < deadline, 'Model did not start the cancellation tool');
      await new Promise(r => setTimeout(r, 50));
    }
    await h.api.notify('session/cancel', { sessionId: session.sessionId });
    assert.equal((await pending).stopReason, 'cancelled');
    await h.stop();
  } finally { h.connection.close(); h.child.kill('SIGKILL'); await rm(root, { recursive: true, force: true }); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { client, methods, PROTOCOL_VERSION, type SessionNotification, type SessionUpdate } from '@agentclientprotocol/sdk';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Adapter } from '../src/adapter.js';
import { Storage } from '../src/sessions/storage.js';

test('installed Pi baseline: native questions, actual tools, errors, cancellation and reopen', {
  skip: process.env.PI_ACP_LIVE_TESTS !== '1', timeout: 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-acp-live-'));
  const cwd = join(root, 'workspace'); const agentDir = join(root, 'agent');
  await mkdir(cwd); await mkdir(agentDir);
  await writeFile(join(cwd, 'sample.txt'), 'before\n');
  const updates: SessionNotification[] = [];
  const diagnostics: string[] = [];
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
  const adapter = new Adapter({ executable: process.env.PI_ACP_PI ?? 'pi', storage: new Storage(agentDir, join(root, 'sessions'), env), env,
    diagnostic: m => diagnostics.push(m),
    launch: original => ({ ...original, args: [...original.args!, '--extension', resolve('test/fixtures/live-extension.js'),
      '--provider', 'pi-acp-fixture', '--model', 'fixture'] }) });
  const app = client({ name: 'independent-live-acp-client' });
  app.onNotification(methods.client.session.update, c => { updates.push(c.params); });
  app.onRequest(methods.client.elicitation.create, c => ({ action: 'accept', content: { answer: c.params.message === 'Pick a value' ? 'two' : 'live answer' } }));
  const connection = app.connect(adapter.app);
  const api = connection.agent;
  try {
    await api.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { elicitation: { form: {} } } });
    const session = await api.request('session/new', { cwd, mcpServers: [] });
    const prompt = (text: string) => api.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text }] });
    assert.ok(updates.some(n => n.update.sessionUpdate === 'available_commands_update' && n.update.availableCommands.some(c => c.name === 'name')));
    await prompt('/name Live title 🦊');
    assert.ok(updates.some(n => n.update.sessionUpdate === 'session_info_update' && n.update.title === 'Live title 🦊'));
    await prompt('/fixture-background-name');
    const nameDeadline = Date.now() + 2000;
    while (!updates.some(n => n.update.sessionUpdate === 'session_info_update' && n.update.title === 'Background title 🦊')) {
      assert.ok(Date.now() < nameDeadline, 'Actual Pi did not publish the background name');
      await new Promise(r => setTimeout(r, 10));
    }
    assert.equal((await api.request('session/list', { cwd })).sessions[0]!.title, 'Background title 🦊');
    await prompt('/fixture-name');
    assert.ok(updates.some(n => n.update.sessionUpdate === 'session_info_update' && n.update.title === null));
    assert.equal((await api.request('session/list', { cwd })).sessions[0]!.title, undefined);
    await prompt('/name Saved live title');
    assert.equal((await prompt('/fixture-handled')).stopReason, 'end_turn');
    assert.equal((await prompt('/fixture-question')).stopReason, 'end_turn');
    assert.equal((await prompt('question')).stopReason, 'end_turn');
    assert.ok(updates.some(n => n.update.sessionUpdate === 'tool_call_update' && JSON.stringify(n.update.content ?? []).includes('two')));
    assert.equal((await prompt('exercise tools')).stopReason, 'end_turn');
    assert.equal(await readFile(join(cwd, 'sample.txt'), 'utf8'), 'after\n');
    assert.equal(await readFile(join(cwd, 'created.txt'), 'utf8'), 'created\n');
    const fileUpdates = updates.map(n => n.update).filter((u): u is Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }> => u.sessionUpdate === 'tool_call_update' && u.status === 'completed' && u.rawOutput !== undefined);
    const editPreview = fileUpdates.find(u => u.title === 'edit');
    const writePreview = fileUpdates.find(u => u.title === 'write');
    const canonicalCwd = await realpath(cwd);
    assert.equal((editPreview?.rawOutput as { path?: string })?.path, join(canonicalCwd, 'sample.txt'));
    assert.match((editPreview?.rawOutput as { patch?: string })?.patch ?? '', /-before\n\+after/);
    assert.deepEqual(writePreview?.rawOutput, { path: join(canonicalCwd, 'created.txt'), newText: 'created\n', truncated: false });
    assert.ok(updates.some(n => n.update.sessionUpdate === 'tool_call_update' && JSON.stringify(n.update.content ?? []).includes('fixture output')));
    await prompt('failed tool');
    assert.ok(updates.some(n => n.update.sessionUpdate === 'tool_call_update' && n.update.status === 'failed'));
    await assert.rejects(prompt('provider failure'), /provider failed/);
    const running = prompt('wait');
    await new Promise(r => setTimeout(r, 150));
    await api.notify('session/cancel', { sessionId: session.sessionId });
    assert.equal((await running).stopReason, 'cancelled');
    const liveIds = updates.flatMap(n => 'messageId' in n.update ? [n.update.messageId] : []);
    await api.request('session/close', { sessionId: session.sessionId }); updates.length = 0;
    await api.request('session/load', { sessionId: session.sessionId, cwd, mcpServers: [] });
    assert.ok(updates.some(n => n.update.sessionUpdate === 'session_info_update' && n.update.title === 'Saved live title'));
    const replayIds = updates.flatMap(n => 'messageId' in n.update ? [n.update.messageId] : []);
    assert.deepEqual([...new Set(replayIds)], [...new Set(liveIds)], diagnostics.join('\n'));
    const replayFiles = updates.map(n => n.update).filter(u => u.sessionUpdate === 'tool_call_update' && u.status === 'completed' && u.rawOutput !== undefined);
    assert.deepEqual(replayFiles, fileUpdates);
    const listing = await api.request('session/list', { cwd }); assert.equal(listing.sessions.length, 1);
    assert.equal(listing.sessions[0]!.title, 'Saved live title');
  } finally { connection.close(); await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

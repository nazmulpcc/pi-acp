import { test } from 'node:test';
import assert from 'node:assert/strict';
import { client, methods, PROTOCOL_VERSION, type SessionNotification, type CreateElicitationResponse } from '@agentclientprotocol/sdk';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Adapter } from '../src/adapter.js';
import { Storage } from '../src/sessions/storage.js';

async function harness(options: { question?: () => Promise<CreateElicitationResponse>; form?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-acp-client-'));
  const cwd = join(root, 'workspace'); await mkdir(cwd);
  const notifications: SessionNotification[] = [];
  const adapter = new Adapter({ executable: 'fixture', storage: new Storage(join(root, 'agent'), join(root, 'sessions')),
    verify: async () => {}, launch: original => ({ ...original, executable: process.execPath, args: [resolve('test/fixtures/fake-pi.mjs'), ...original.args!] }) });
  const app = client({ name: 'independent-acp-test-client' });
  app.onNotification(methods.client.session.update, context => { notifications.push(context.params); });
  app.onRequest(methods.client.elicitation.create, () => options.question?.() ?? Promise.resolve({ action: 'cancel' as const }));
  const connection = app.connect(adapter.app);
  const api = connection.agent;
  await api.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: options.form === false ? {} : { elicitation: { form: {} } } });
  const session = await api.request('session/new', { cwd, mcpServers: [] });
  const prompt = (text: string) => api.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text }] });
  const close = async () => { connection.close(); await adapter.close(); await rm(root, { recursive: true, force: true }); };
  return { api, cwd, session, prompt, notifications, close, adapter };
}

test('public ACP lifecycle handles fast completion, original history, discovery and configuration', { timeout: 10_000 }, async () => {
  const h = await harness();
  try {
    assert.equal((await h.prompt('fast')).stopReason, 'end_turn');
    const live = h.notifications.filter(n => ['user_message_chunk', 'agent_message_chunk'].includes(n.update.sessionUpdate)).map(n => n.update);
    await h.api.request('session/set_config_option', { sessionId: h.session.sessionId, configId: 'thinking', value: 'high' });
    const listing = await h.api.request('session/list', { cwd: h.cwd });
    assert.equal(listing.sessions[0]!.sessionId, h.session.sessionId);
    await h.api.request('session/close', { sessionId: h.session.sessionId });
    h.notifications.length = 0;
    await h.api.request('session/load', { sessionId: h.session.sessionId, cwd: h.cwd, mcpServers: [] });
    const replay = h.notifications.filter(n => ['user_message_chunk', 'agent_message_chunk'].includes(n.update.sessionUpdate)).map(n => n.update);
    assert.deepEqual(replay, live);
    assert.equal((await h.prompt('/handled')).stopReason, 'end_turn');
  } finally { await h.close(); }
});

test('native question runs before prompt acceptance and is answered in the same request', { timeout: 10_000 }, async () => {
  const h = await harness({ question: async () => ({ action: 'accept', content: { answer: 'chosen' } }) });
  try {
    assert.equal((await h.prompt('/question')).stopReason, 'end_turn');
    assert.ok(h.notifications.some(n => n.update.sessionUpdate === 'agent_message_chunk' && n.update.content.type === 'text' && n.update.content.text === 'chosen'));
  } finally { await h.close(); }
});

test('cancellation while awaiting input releases prompt and ignores late answer', { timeout: 10_000 }, async () => {
  let asked!: () => void;
  const question = new Promise<void>(r => { asked = r; });
  let answer!: (r: CreateElicitationResponse) => void;
  const h = await harness({ question: () => { asked(); return new Promise(r => { answer = r; }); } });
  try {
    const pending = h.prompt('/question');
    await question;
    await h.api.notify('session/cancel', { sessionId: h.session.sessionId });
    assert.equal((await pending).stopReason, 'cancelled');
    answer({ action: 'accept', content: { answer: 'late' } });
    assert.equal((await h.prompt('normal')).stopReason, 'end_turn');
  } finally { await h.close(); }
});

test('retries do not settle early; terminal errors and token limits remain distinct', { timeout: 10_000 }, async () => {
  const h = await harness();
  try {
    assert.equal((await h.prompt('retry')).stopReason, 'end_turn');
    assert.ok(h.notifications.some(n => n.update.sessionUpdate === 'agent_message_chunk' && n.update.content.type === 'text' && n.update.content.text === 'Recovered'));
    assert.equal((await h.prompt('tokens')).stopReason, 'max_tokens');
    await assert.rejects(h.prompt('error'), /provider failed/);
    await assert.rejects(h.prompt('/extension-error'), /extension/);
  } finally { await h.close(); }
});

test('busy prompts reject and independent sessions remain isolated during cancellation', { timeout: 10_000 }, async () => {
  const h = await harness();
  try {
    const pending = h.prompt('wait');
    await new Promise(resolve => setTimeout(resolve, 50));
    await assert.rejects(h.prompt('normal'), /busy/);
    const other = await h.api.request('session/new', { cwd: h.cwd, mcpServers: [] });
    await h.api.request('session/prompt', { sessionId: other.sessionId, prompt: [{ type: 'text', text: 'normal' }] });
    await h.api.notify('session/cancel', { sessionId: h.session.sessionId });
    assert.equal((await pending).stopReason, 'cancelled');
  } finally { await h.close(); }
});

test('tool arguments, interleaving and unsuccessful tool results survive reopen', { timeout: 10_000 }, async () => {
  const h = await harness();
  try {
    await h.prompt('tools');
    const liveCalls = h.notifications.map(n => n.update).filter(u => u.sessionUpdate === 'tool_call');
    assert.equal(liveCalls.length, 1); assert.deepEqual(liveCalls[0]!.rawInput, { command: 'false' });
    assert.ok(h.notifications.some(n => n.update.sessionUpdate === 'tool_call_update' && n.update.status === 'failed'));
    await h.api.request('session/close', { sessionId: h.session.sessionId }); h.notifications.length = 0;
    await h.api.request('session/load', { sessionId: h.session.sessionId, cwd: h.cwd, mcpServers: [] });
    assert.deepEqual(h.notifications.map(n => n.update).filter(u => u.sessionUpdate === 'tool_call'), liveCalls);
    assert.ok(h.notifications.some(n => n.update.sessionUpdate === 'tool_call_update' && n.update.status === 'failed'));
  } finally { await h.close(); }
});

test('unsupported client forms cancel safely and session identity changes fail explicitly', { timeout: 10_000 }, async () => {
  const h = await harness({ form: false });
  try {
    assert.equal((await h.prompt('/question')).stopReason, 'end_turn');
    await assert.rejects(h.prompt('/switch'), /identity/);
  } finally { await h.close(); }
});

test('child crash rejects prompt and rejects silent session replacement', { timeout: 10_000 }, async () => {
  const h = await harness();
  try { await assert.rejects(h.prompt('crash'), /closed|exited/); await assert.rejects(h.prompt('normal'), /unavailable/); }
  finally { await h.close(); }
});

test('disconnect during session startup releases the owned child and writer lease', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-acp-startup-'));
  const pidFile = join(root, 'child.pid');
  const storage = new Storage(join(root, 'agent'), join(root, 'sessions'));
  const adapter = new Adapter({ executable: 'fixture', storage, verify: async () => {},
    launch: original => ({ ...original, executable: process.execPath,
      args: [resolve('test/fixtures/fake-pi.mjs'), '--startup-wait', ...original.args!],
      env: { ...process.env, PI_ACP_FIXTURE_PID_FILE: pidFile } }) });
  const connection = client({ name: 'disconnect-during-startup' }).connect(adapter.app);
  try {
    await connection.agent.request('initialize', { protocolVersion: PROTOCOL_VERSION });
    const pending = connection.agent.request('session/new', { cwd: root, mcpServers: [] });
    const rejected = assert.rejects(pending);
    const deadline = Date.now() + 3000;
    let pid: number | undefined;
    while (!pid) {
      try { pid = Number(await readFile(pidFile, 'utf8')); } catch {}
      assert.ok(Date.now() < deadline, 'Startup child did not launch');
      if (!pid) await new Promise(r => setTimeout(r, 10));
    }
    connection.close(); await adapter.close(); await rejected;
    assert.throws(() => process.kill(pid!, 0), { code: 'ESRCH' });
  } finally { connection.close(); await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

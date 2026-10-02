import { test } from 'node:test';
import assert from 'node:assert/strict';
import { client, methods, PROTOCOL_VERSION, type SessionNotification, type CreateElicitationResponse } from '@agentclientprotocol/sdk';
import { mkdtemp, mkdir, readFile, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Adapter } from '../src/adapter.js';
import { Storage } from '../src/sessions/storage.js';
import { readHistory, type Entry } from '../src/sessions/history.js';
import { limits } from '../src/limits.js';
import { notificationBytes } from '../src/acp-wire.js';

async function harness(options: { question?: () => Promise<CreateElicitationResponse>; form?: boolean; nameCommand?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-acp-client-'));
  const cwd = join(root, 'workspace'); await mkdir(cwd);
  const notifications: SessionNotification[] = [];
  const storage = new Storage(join(root, 'agent'), join(root, 'sessions'));
  const adapter = new Adapter({ executable: 'fixture', storage,
    verify: async () => {}, launch: original => ({ ...original, executable: process.execPath,
      env: { ...process.env, ...(options.nameCommand ? { PI_ACP_FIXTURE_NAME_COMMAND: '1' } : {}) },
      args: [resolve('test/fixtures/fake-pi.mjs'), ...original.args!] }) });
  const app = client({ name: 'independent-acp-test-client' });
  app.onNotification(methods.client.session.update, context => { notifications.push(context.params); });
  app.onRequest(methods.client.elicitation.create, () => options.question?.() ?? Promise.resolve({ action: 'cancel' as const }));
  const connection = app.connect(adapter.app);
  const api = connection.agent;
  await api.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: options.form === false ? {} : { elicitation: { form: {} } } });
  const session = await api.request('session/new', { cwd, mcpServers: [] });
  const prompt = (text: string) => api.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text }] });
  const close = async () => { connection.close(); await adapter.close(); await rm(root, { recursive: true, force: true }); };
  return { api, cwd, session, prompt, notifications, close, adapter, storage };
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

test('names are advertised, changed without a model run, listed and published on load/resume', { timeout: 10_000 }, async () => {
  const h = await harness();
  try {
    assert.ok(h.notifications.some(n => n.update.sessionUpdate === 'available_commands_update' && n.update.availableCommands.some(c => c.name === 'name')));
    await h.prompt('/name');
    assert.ok(h.notifications.some(n => n.update.sessionUpdate === 'agent_message_chunk' && n.update.content.type === 'text' && n.update.content.text === 'Usage: /name <name>'));
    await h.prompt('/name   Fix login 🦊\n bug   ');
    const expected = 'Fix login 🦊  bug';
    assert.ok(h.notifications.some(n => n.update.sessionUpdate === 'session_info_update' && n.update.title === expected));
    assert.equal((await h.api.request('session/list', { cwd: h.cwd })).sessions[0]!.title, expected);
    const stored = await h.storage.find(h.session.sessionId, h.cwd);
    assert.equal((await readHistory(stored.path)).entries.filter(e => e.type === 'message').length, 0, '/name must not invoke the model');
    h.notifications.length = 0;
    await h.prompt('/name');
    assert.ok(h.notifications.some(n => n.update.sessionUpdate === 'agent_message_chunk' && n.update.content.type === 'text' && n.update.content.text === `Session name: ${expected}`));
    for (const method of ['session/load', 'session/resume'] as const) {
      await h.api.request('session/close', { sessionId: h.session.sessionId });
      h.notifications.length = 0;
      await h.api.request(method, { sessionId: h.session.sessionId, cwd: h.cwd, mcpServers: [] });
      assert.ok(h.notifications.some(n => n.update.sessionUpdate === 'session_info_update' && n.update.title === expected));
    }
    const fullName = '🦊'.repeat(80);
    await h.prompt(`/name ${fullName}`);
    assert.equal((await h.api.request('session/list', { cwd: h.cwd })).sessions[0]!.title, '🦊'.repeat(64));
    assert.equal((await readHistory(stored.path)).entries.filter(e => e.type === 'session_info').at(-1)?.name, fullName);
  } finally { await h.close(); }
});

test('idle title events update live listing, clear names and cannot be rolled back by stale state', { timeout: 10_000 }, async () => {
  const h = await harness();
  try {
    await h.prompt('/late-name');
    const deadline = Date.now() + 2000;
    while (!h.notifications.some(n => n.update.sessionUpdate === 'session_info_update' && n.update.title === 'Background title 🦊')) {
      assert.ok(Date.now() < deadline, 'Missing idle title event');
      await new Promise(r => setTimeout(r, 10));
    }
    // A storage snapshot can lag the event; the live session must override it.
    const discover = h.storage.discover.bind(h.storage);
    h.storage.discover = async cwd => (await discover(cwd)).map(s => ({ ...s, title: 'Stale disk title' }));
    assert.equal((await h.api.request('session/list', { cwd: h.cwd })).sessions[0]!.title, 'Background title 🦊');
    h.notifications.length = 0;
    await h.prompt('/name-race');
    assert.deepEqual(h.notifications.flatMap(n => n.update.sessionUpdate === 'session_info_update' ? [n.update.title] : []), ['Newest title']);
    await h.prompt('/clear-name');
    assert.ok(h.notifications.some(n => n.update.sessionUpdate === 'session_info_update' && n.update.title === null));
    assert.equal((await h.api.request('session/list', { cwd: h.cwd })).sessions[0]!.title, undefined);
    h.storage.discover = discover;
    await h.api.request('session/close', { sessionId: h.session.sessionId });
    assert.equal((await h.api.request('session/list', { cwd: h.cwd })).sessions[0]!.title, undefined);
  } finally { await h.close(); }
});

test('an existing Pi /name command keeps its catalog and invocation semantics', { timeout: 10_000 }, async () => {
  const h = await harness({ nameCommand: true });
  try {
    const commands = h.notifications.flatMap(n => n.update.sessionUpdate === 'available_commands_update' ? n.update.availableCommands : []).filter(c => c.name === 'name');
    assert.equal(commands.length, 1); assert.equal(commands[0]!.description, 'Extension name command');
    await h.prompt('/name Custom');
    assert.equal((await h.api.request('session/list', { cwd: h.cwd })).sessions[0]!.title, 'Extension: Custom');
  } finally { await h.close(); }
});

test('large and oversized-turn histories load a bounded newest window and continue the same file', { timeout: 20_000 }, async () => {
  for (const oversized of [false, true]) {
    const h = await harness();
    try {
      await h.prompt('normal');
      await h.api.request('session/close', { sessionId: h.session.sessionId });
      const stored = await h.storage.find(h.session.sessionId, h.cwd);
      const existing = await readHistory(stored.path);
      let parentId = existing.leafId;
      const records: Entry[] = [];
      const count = oversized ? 1 : 24;
      for (let i = 0; i < count; i++) {
        for (const message of [
          { role: 'user', content: `retained-user-${i}` },
          { role: 'assistant', content: [{ type: 'text', text: 'payload:'.repeat(oversized ? 1_300_000 : 80_000) }], stopReason: 'stop' },
        ]) {
          const id = `offline-${records.length}`;
          records.push({ type: 'message', id, parentId, timestamp: '', message }); parentId = id;
        }
      }
      await appendFile(stored.path, records.map(r => JSON.stringify(r) + '\n').join(''));
      const original = await readFile(stored.path, 'utf8');
      const originalAliases = await h.storage.aliases(h.session.sessionId);
      h.notifications.length = 0;
      const loaded = await h.api.request('session/load', { sessionId: h.session.sessionId, cwd: h.cwd, mcpServers: [] });
      assert.deepEqual(loaded._meta, { 'com.airterm/pi-acp': { historyTruncated: true } });
      assert.equal(await readFile(stored.path, 'utf8'), original);
      assert.deepEqual(await h.storage.aliases(h.session.sessionId), originalAliases);
      const anchor = h.notifications.filter(n => n.update.sessionUpdate === 'user_message_chunk');
      assert.ok(anchor.some(n => n.update.sessionUpdate === 'user_message_chunk' && n.update.content.type === 'text' && n.update.content.text === `retained-user-${count - 1}`));
      const historyUpdates = h.notifications.filter(n => 'messageId' in n.update || n.update.sessionUpdate === 'tool_call' || n.update.sessionUpdate === 'tool_call_update');
      assert.ok(historyUpdates.reduce((sum, n) => sum + notificationBytes(h.session.sessionId, n.update), 0) <= limits.replayBytes);
      assert.ok(h.notifications.some(n => n.update.sessionUpdate === 'agent_message_chunk' && n.update.content.type === 'text' && n.update.content.text.includes('display history was omitted')));
      assert.equal((await h.prompt('normal')).stopReason, 'end_turn');
      const continued = await readHistory(stored.path);
      assert.equal(continued.header.id, h.session.sessionId);
      assert.equal(continued.entries.length, existing.entries.length + records.length + 2);
    } finally { await h.close(); }
  }
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
    assert.equal((await h.prompt('compaction')).stopReason, 'end_turn');
    await assert.rejects(h.prompt('compaction-error'), /compaction failed/);
    await assert.rejects(h.prompt('retry-exhausted'), /retries exhausted/);
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

test('unresponsive cancellation closes its generation and requires explicit reopen', { timeout: 12_000 }, async () => {
  const h = await harness();
  try {
    const pending = h.prompt('stuck');
    const deadline = Date.now() + 3000;
    while (!h.notifications.some(n => n.update.sessionUpdate === 'agent_message_chunk')) {
      assert.ok(Date.now() < deadline, 'Prompt did not start');
      await new Promise(r => setTimeout(r, 10));
    }
    await h.api.notify('session/cancel', { sessionId: h.session.sessionId });
    assert.equal((await pending).stopReason, 'cancelled');
    await assert.rejects(h.prompt('normal'), /unavailable/);
    await h.api.request('session/resume', { sessionId: h.session.sessionId, cwd: h.cwd, mcpServers: [] });
    assert.equal((await h.prompt('normal')).stopReason, 'end_turn');
  } finally { await h.close(); }
});

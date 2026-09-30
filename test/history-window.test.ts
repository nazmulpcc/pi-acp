import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { projectHistoryWindow, type Entry, type History } from '../src/sessions/history.js';
import { notificationBytes } from '../src/acp-wire.js';
import { limits } from '../src/limits.js';

function history(messages: unknown[]): History {
  const entries = messages.map((message, i) => ({ type: 'message', id: `e${i}`, parentId: i ? `e${i - 1}` : null, timestamp: '', message }));
  return { header: { type: 'session', version: 3, id: 'session', cwd: '/workspace', timestamp: '' }, entries, leafId: entries.at(-1)?.id ?? null };
}
const user = (text: string) => ({ role: 'user', content: text });
const assistant = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' });
const call = (id: string, args: Record<string, unknown> = { path: 'a.txt' }) => ({ role: 'assistant', content: [{ type: 'toolCall', id, name: 'read', arguments: args }] });
const result = (id: string, text = 'read result', failed = false) => ({ role: 'toolResult', toolCallId: id, content: [{ type: 'text', text }], isError: failed });
const text = (u: SessionUpdate) => (u.sessionUpdate === 'agent_message_chunk' || u.sessionUpdate === 'user_message_chunk' || u.sessionUpdate === 'agent_thought_chunk') && u.content.type === 'text' ? u.content.text : '';
const anchors = (updates: SessionUpdate[]) => updates.filter(u => u.sessionUpdate === 'user_message_chunk').map(text);
const wireBytes = (updates: SessionUpdate[]) => updates.reduce((sum, u) => sum + notificationBytes('session', u), 0);

test('restore selects the newest complete user turns from more than 8 MiB of projected history', () => {
  const messages = Array.from({ length: 24 }, (_, i) => [user(`turn-${i}`), assistant(`${i}:` + 'a'.repeat(600 * 1024))]).flat();
  const h = history(messages);
  const aliases = new Map([['e46', 'newest-user'], ['e47', 'newest-reply']]);
  const projected = projectHistoryWindow(h, aliases);
  assert.equal(projected.truncated, true);
  assert.ok(wireBytes(projected.updates) <= limits.replayBytes);
  const retained = anchors(projected.updates);
  assert.ok(retained.length > 0 && retained.length < 24);
  assert.equal(retained.at(-1), 'turn-23');
  const first = Number(retained[0]!.split('-')[1]);
  assert.deepEqual(retained, Array.from({ length: 24 - first }, (_, i) => `turn-${first + i}`));
  assert.ok(projected.updates.some(u => 'messageId' in u && u.messageId === 'newest-user/block/0'));
  assert.ok(projected.updates.some(u => 'messageId' in u && u.messageId === 'newest-reply/block/0'));
  assert.match(text(projected.updates[0]!), /display history was omitted/);
  assert.equal(h.entries.length, 48); assert.equal(aliases.size, 2);
});

test('an oversized newest turn preserves its user anchor and a bounded reply, not a load error', () => {
  const newest = 'huge-reply:' + 'x'.repeat(limits.replayBytes + 1024);
  const projected = projectHistoryWindow(history([user('old'), assistant('old reply'), user('newest'), assistant(newest)]));
  assert.equal(projected.truncated, true);
  assert.deepEqual(anchors(projected.updates), ['newest']);
  assert.ok(wireBytes(projected.updates) <= limits.replayBytes);
  assert.ok(projected.updates.some(u => text(u).startsWith('huge-reply:') && text(u).includes('truncated')));
  assert.ok(!projected.updates.some(u => text(u) === 'old reply'));
});

test('newest tools retain statuses and locations without forwarding large historical logs', () => {
  const projected = projectHistoryWindow(history([user('read it'), call('tool'), result('tool', 'heavy-log'.repeat(100_000), true), assistant('done')]));
  assert.equal(projected.truncated, true);
  const declared = projected.updates.find(u => u.sessionUpdate === 'tool_call');
  assert.ok(declared?.sessionUpdate === 'tool_call');
  assert.deepEqual(declared.locations, [{ path: resolve('/workspace', 'a.txt') }]);
  const completed = projected.updates.find(u => u.sessionUpdate === 'tool_call_update' && u.status === 'failed');
  assert.ok(completed?.sessionUpdate === 'tool_call_update');
  assert.equal(completed.toolCallId, declared.toolCallId);
  assert.equal(completed._meta?.outputTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(completed.content)) <= limits.replayToolOutputBytes + 128);
  assert.ok(JSON.stringify(completed.content).includes('truncated'));
});

test('cross-user tool links merge boundaries and repeated completed IDs in separate turns stay distinct', () => {
  const messages = [user('owner'), call('cross'), user('continued'), result('cross'), assistant('done'),
    user('second'), call('reuse'), result('reuse'), assistant('two'), user('third'), call('reuse'), result('reuse'), assistant('three')];
  const projected = projectHistoryWindow(history(messages));
  assert.equal(projected.truncated, false);
  const calls = projected.updates.filter(u => u.sessionUpdate === 'tool_call');
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls.map(u => u.toolCallId)).size, 3);
  const results = projected.updates.filter((u): u is Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }> => u.sessionUpdate === 'tool_call_update' && u.status === 'completed');
  assert.deepEqual(results.map(u => u.toolCallId), calls.map(u => u.toolCallId));
  const padded = history([user('old'), assistant('x'.repeat(7 * 1024 * 1024)), ...messages.slice(0, 5)]);
  // Make the merged latest pair exceed the remaining budget so the old group is evicted.
  (padded.entries.at(-1)!.message as { content: unknown }).content = [{ type: 'text', text: 'y'.repeat(2 * 1024 * 1024) }];
  const tail = projectHistoryWindow(padded);
  assert.deepEqual(anchors(tail.updates), ['owner', 'continued']);
  const tailCalls = tail.updates.filter(u => u.sessionUpdate === 'tool_call');
  assert.equal(tailCalls.length, 1);
  assert.ok(tail.updates.some(u => u.sessionUpdate === 'tool_call_update' && u.toolCallId === tailCalls[0]!.toolCallId && u.status === 'completed'));
  // A cross-user result keeps this whole group together; a different completed
  // tool ID can still be reused within that merged group without aliasing calls.
  const merged = projectHistoryWindow(history([user('start'), call('pending'), call('reused'), result('reused'),
    user('continue'), call('reused'), result('reused'), result('pending'), assistant('done')]));
  const mergedCalls = merged.updates.filter(u => u.sessionUpdate === 'tool_call');
  assert.equal(new Set(mergedCalls.map(u => u.toolCallId)).size, 3);
  assert.equal(merged.updates.filter(u => u.sessionUpdate === 'tool_call_update' && u.status === 'completed').length, 3);
});

test('tool counters reset per restored turn and bulk omitted inputs do not trip live byte counters', () => {
  const manyTurns = history(Array.from({ length: 4200 }, (_, i) => [user(`u${i}`), call(`t${i}`), result(`t${i}`)]).flat());
  const projected = projectHistoryWindow(manyTurns);
  assert.equal(projected.truncated, false);
  assert.equal(projected.updates.filter(u => u.sessionUpdate === 'tool_call').length, 4200);
  const bulk = history([user('bulk'), ...Array.from({ length: 28 }, (_, i) => [call(`b${i}`, { payload: 'x'.repeat(700 * 1024) }), result(`b${i}`)]).flat(), assistant('finished')]);
  const bounded = projectHistoryWindow(bulk);
  assert.equal(bounded.truncated, true); // Omitted inputs are explicit, not an error.
  assert.equal(bounded.updates.filter(u => u.sessionUpdate === 'tool_call').length, 28);
  assert.ok(wireBytes(bounded.updates) <= limits.replayBytes);
});

test('a pathological oversized tool turn omits activity coherently and retains newest user/reply identities', () => {
  const h = history([user('newest'), ...Array.from({ length: 4200 }, (_, i) => [call(`t${i}`), result(`t${i}`)]).flat(), assistant('final answer')]);
  const projected = projectHistoryWindow(h);
  assert.equal(projected.truncated, true);
  assert.deepEqual(anchors(projected.updates), ['newest']);
  assert.ok(projected.updates.some(u => text(u) === 'final answer'));
  assert.equal(projected.updates.filter(u => u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update').length, 0);
});

test('small history stays unchanged; invalid omitted messages and corrupt graphs still fail', () => {
  const h = history([user('small'), call('t'), result('t'), assistant('small answer')]);
  const projected = projectHistoryWindow(h);
  assert.equal(projected.truncated, false);
  assert.deepEqual(anchors(projected.updates), ['small']);
  assert.ok(!projected.updates.some(u => text(u).includes('omitted')));
  const invalid = history([{ role: 'invalid', content: 'old invalid' }, user('newest'), assistant('x'.repeat(9 * 1024 * 1024))]);
  assert.throws(() => projectHistoryWindow(invalid), /message shape/);
  const broken = history([user('x')]); broken.entries[0]!.parentId = 'missing';
  assert.throws(() => projectHistoryWindow(broken), /missing/);
  assert.throws(() => projectHistoryWindow(history([result('unknown')])), /no preceding call/);
  // Other branches remain invisible even when their text is large.
  const branch = history([user('active')]);
  branch.entries.push({ type: 'message', id: 'abandoned', parentId: null, timestamp: '', message: assistant('not active') } as Entry);
  assert.deepEqual(anchors(projectHistoryWindow(branch).updates), ['active']);
});

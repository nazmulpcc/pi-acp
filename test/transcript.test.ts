import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { Transcript, boundToolUpdate } from '../src/transcript/messages.js';
import { activeBranch, projectHistory, type Entry } from '../src/sessions/history.js';
import { limits } from '../src/limits.js';
import { notificationBytes } from '../src/acp-wire.js';

test('separated identical blocks keep identity and finals do not duplicate streamed text', () => {
  const updates: SessionUpdate[] = [];
  const t = new Transcript('/workspace', u => updates.push(u), () => 'message');
  t.event({ type: 'message_start', message: { role: 'assistant', content: [] } });
  for (const [contentIndex, type, delta] of [[0, 'text_delta', 'same'], [1, 'thinking_delta', 'think'], [2, 'text_delta', 'same']] as const) {
    t.event({ type: 'message_update', assistantMessageEvent: { type, contentIndex, delta } });
  }
  t.event({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'same' }, { type: 'thinking', thinking: 'think' }, { type: 'text', text: 'same' }] } });
  assert.equal(updates.length, 3);
  assert.deepEqual(updates.map(u => 'messageId' in u ? u.messageId : ''), ['message/block/0', 'message/block/1', 'message/block/2']);
  const replay: SessionUpdate[] = [];
  new Transcript('/workspace', u => replay.push(u)).replay(t.finalized[0]!.message, 'message');
  assert.deepEqual(updates, replay);
});

test('large history text is split without changing identity or Unicode', () => {
  const text = ('🦊\n').repeat(100_000);
  const updates: SessionUpdate[] = [];
  new Transcript('/workspace', u => updates.push(u)).replay({ role: 'assistant', content: [{ type: 'text', text }] }, 'persisted');
  assert.ok(updates.length > 1);
  assert.equal(updates.map(u => u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text' ? u.content.text : '').join(''), text);
  assert.ok(updates.every(u => Buffer.byteLength(JSON.stringify(u)) < limits.updateBytes && 'messageId' in u && u.messageId === 'persisted/block/0'));
});

test('image boundaries do not duplicate, and oversized images are explicitly omitted from display', () => {
  const updates: SessionUpdate[] = [];
  const t = new Transcript('/workspace', u => updates.push(u));
  const message = { role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: 'x'.repeat(limits.outputBytes + 1) }] };
  t.event({ type: 'message_start', message }); t.event({ type: 'message_end', message });
  assert.equal(updates.length, 1);
  const update = updates[0]!;
  assert.match(update.sessionUpdate === 'user_message_chunk' && update.content.type === 'text' ? update.content.text : '', /omitted/);
});

test('escaped tool output and write previews fit the serialized update bound', () => {
  const updates: SessionUpdate[] = [];
  const t = new Transcript('/workspace', u => updates.push(u));
  t.replay({ role: 'assistant', content: [{ type: 'toolCall', id: 'x'.repeat(1024), name: 'write',
    arguments: { path: 'output', content: '\0'.repeat(300_000) } }] }, 'owner');
  t.event({ type: 'tool_execution_end', toolCallId: 'x'.repeat(1024), isError: false,
    result: { content: [{ type: 'text', text: '\0'.repeat(600_000) }], details: { patch: '\0'.repeat(300_000) } } });
  assert.ok(updates.every(u => notificationBytes('', u) <= limits.outputBytes));
  assert.ok(JSON.stringify(updates.at(-1)).includes('truncated'));
  const last = updates.at(-1)!;
  assert.equal(last.sessionUpdate, 'tool_call_update');
  const preview = last.sessionUpdate === 'tool_call_update' ? last.rawOutput as { newText: string; truncated: boolean } : undefined;
  assert.equal(preview?.truncated, true);
  assert.ok('\0'.repeat(300_000).startsWith(preview!.newText));
  assert.ok(Buffer.byteLength(JSON.stringify(preview)) <= limits.previewBytes);
});

test('edit and write previews expose the same bounded fields live and on replay', () => {
  const live: SessionUpdate[] = [];
  let nextId = 0;
  const t = new Transcript('/workspace', u => live.push(u), () => `m${nextId++}`, 'session');
  const assistant = { role: 'assistant', content: [
    { type: 'toolCall', id: 'edit', name: 'edit', arguments: { path: 'sample.txt', edits: [{ oldText: 'before', newText: 'after' }] } },
    { type: 'toolCall', id: 'write', name: 'write', arguments: { path: 'created.txt', content: 'created\n' } },
  ] };
  t.event({ type: 'message_start', message: { role: 'assistant', content: [] } });
  t.event({ type: 'message_end', message: assistant });
  const results = [
    { role: 'toolResult', toolCallId: 'edit', isError: false, content: [{ type: 'text', text: 'edited' }], details: { patch: '--- a/sample.txt\n+++ b/sample.txt\n@@ -1 +1 @@\n-before\n+after\n', secret: 'PRIVATE' } },
    { role: 'toolResult', toolCallId: 'write', isError: false, content: [{ type: 'text', text: 'written' }], details: { secret: 'PRIVATE' } },
  ];
  for (const message of results) {
    t.event({ type: 'tool_execution_end', toolCallId: message.toolCallId, isError: false, result: message });
    t.event({ type: 'message_start', message }); t.event({ type: 'message_end', message });
  }
  const completed = (updates: SessionUpdate[]) => updates.filter(u => u.sessionUpdate === 'tool_call_update' && u.status === 'completed');
  const replay = projectHistory({ header: { type: 'session', version: 3, id: 'session', cwd: '/workspace', timestamp: '' }, leafId: 'e2',
    entries: t.finalized.map((f, i) => ({ type: 'message', id: `e${i}`, parentId: i ? `e${i - 1}` : null, timestamp: '', message: f.message })) },
    new Map(t.finalized.map((f, i) => [`e${i}`, f.id])));
  assert.deepEqual(completed(replay), completed(live));
  const outputs = completed(live).map(u => u.sessionUpdate === 'tool_call_update' ? u.rawOutput : undefined);
  assert.deepEqual(outputs, [
    { path: resolve('/workspace', 'sample.txt'), patch: results[0]!.details.patch, truncated: false },
    { path: resolve('/workspace', 'created.txt'), newText: 'created\n', truncated: false },
  ]);
  assert.ok(!JSON.stringify(outputs).includes('PRIVATE'));
  assert.ok(!Object.hasOwn(outputs[1] as object, 'oldText'));
});

test('failed writes and unknown tool details never claim a file preview', () => {
  const updates: SessionUpdate[] = [];
  const t = new Transcript('/workspace', u => updates.push(u));
  for (const [id, name] of [['failed', 'write'], ['unknown', 'custom']] as const) {
    t.replay({ role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: { path: 'x', content: 'never written' } }] }, id);
    t.event({ type: 'tool_execution_end', toolCallId: id, isError: id === 'failed', result: { content: [{ type: 'text', text: 'result' }], details: { patch: 'PRIVATE DETAILS' } } });
  }
  assert.ok(updates.every(u => !('rawOutput' in u) || u.rawOutput === undefined));
  assert.ok(!JSON.stringify(updates).includes('PRIVATE DETAILS'));
  assert.ok(updates.some(u => u.sessionUpdate === 'tool_call_update' && u.status === 'failed'));
});

test('the complete tool event budget accounts for escaping, envelope, input and previews', () => {
  const sessionId = '\0'.repeat(1024);
  const original = { sessionUpdate: 'tool_call_update' as const, toolCallId: 'tool', title: 'edit', status: 'failed' as const,
    rawInput: { content: 'x'.repeat(500_000) }, rawOutput: { path: resolve('/workspace', 'x'), patch: '🦊\n'.repeat(20_000), truncated: false },
    content: [{ type: 'content' as const, content: { type: 'text' as const, text: '\0'.repeat(400_000) } }] };
  const bounded = boundToolUpdate(original, sessionId);
  assert.ok(notificationBytes(sessionId, bounded) <= limits.outputBytes);
  assert.deepEqual(bounded.rawOutput, original.rawOutput);
  assert.equal(bounded.status, 'failed');
  assert.equal(bounded.rawInput, undefined);
  assert.equal(bounded._meta?.outputTruncated, true);
  assert.equal(original.rawInput.content.length, 500_000);
  const inputOnly = boundToolUpdate({ sessionUpdate: 'tool_call', toolCallId: 'call', title: 'write', status: 'pending', rawInput: { content: 'x'.repeat(limits.outputBytes - 10) } }, sessionId);
  assert.ok(notificationBytes(sessionId, inputOnly) <= limits.outputBytes);
  assert.equal(inputOnly.rawInput, undefined);
});

test('tool snapshots replace output and preserve arguments, failure and absolute locations', () => {
  const updates: SessionUpdate[] = [];
  const t = new Transcript('/workspace', u => updates.push(u), () => 'message');
  t.event({ type: 'message_start', message: { role: 'assistant', content: [] } });
  t.event({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tool', name: 'edit', arguments: { path: 'a.ts', edits: [{ oldText: 'a', newText: 'b' }] } }] } });
  t.event({ type: 'tool_execution_start', toolCallId: 'tool', toolName: 'edit', args: { path: 'a.ts' } });
  t.event({ type: 'tool_execution_update', toolCallId: 'tool', partialResult: { content: [{ type: 'text', text: 'a' }] } });
  t.event({ type: 'tool_execution_update', toolCallId: 'tool', partialResult: { content: [{ type: 'text', text: 'ab' }] } });
  t.event({ type: 'tool_execution_end', toolCallId: 'tool', isError: true, result: { content: [{ type: 'text', text: 'failed' }] } });
  assert.equal(updates.at(-1)!.sessionUpdate, 'tool_call_update');
  assert.deepEqual((updates[0] as { locations: unknown }).locations, [{ path: resolve('/workspace', 'a.ts') }]);
  assert.equal((updates.at(-1) as { status: unknown }).status, 'failed');
  assert.deepEqual((updates.at(-2) as { content: unknown }).content, [{ type: 'content', content: { type: 'text', text: 'ab' } }]);
});

test('active branch rejects corrupt graphs and retains original compacted transcript', () => {
  const entry = (id: string, parentId: string | null, text: string): Entry => ({ type: 'message', id, parentId, timestamp: '', message: { role: 'user', content: text } });
  const entries = [entry('a', null, 'original'), entry('b', 'a', 'abandoned'), entry('c', 'a', 'active'),
    { type: 'compaction', id: 'd', parentId: 'c', timestamp: '', summary: 'summary' },
    { type: 'context_edit', id: 'e', parentId: 'd', timestamp: '', targetId: 'a', replacement: null }];
  assert.deepEqual(activeBranch(entries, 'e').map(e => e.id), ['a', 'c', 'd', 'e']);
  const updates = projectHistory({ header: { type: 'session', version: 3, id: 's', cwd: '/workspace', timestamp: '' }, entries, leafId: 'e' });
  assert.deepEqual(updates.map(u => 'content' in u ? u.content : ''), [{ type: 'text', text: 'original' }, { type: 'text', text: 'active' }]);
  assert.throws(() => activeBranch([entry('a', 'a', '')], 'a'), /cycle/);
  assert.throws(() => activeBranch([entry('a', 'missing', '')], 'a'), /missing/);
});

test('non-prefix final corrections fail explicitly rather than duplicating content', () => {
  const t = new Transcript('/workspace', () => {});
  t.event({ type: 'message_start', message: { role: 'assistant', content: [] } });
  t.event({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'before' } });
  assert.throws(() => t.event({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'after' }] } }), /retract/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { Transcript } from '../src/transcript/messages.js';
import { activeBranch, projectHistory, type Entry } from '../src/sessions/history.js';

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
  assert.deepEqual((updates[0] as { locations: unknown }).locations, [{ path: '/workspace/a.ts' }]);
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

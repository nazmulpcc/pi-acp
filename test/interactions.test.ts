import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CreateElicitationRequest, CreateElicitationResponse } from '@agentclientprotocol/sdk';
import { Interactions } from '../src/interactions.js';

test('native input replies to the original dialog without another prompt', async () => {
  const replies: Record<string, unknown>[] = [];
  let request: CreateElicitationRequest | undefined;
  const bridge = new Interactions('s', { createElicitation: async r => { request = r; return { action: 'accept', content: { answer: 'value' } }; } }, true,
    async r => { replies.push(r); }, () => {}, () => {});
  bridge.receive({ type: 'extension_ui_request', id: 'provider-id', method: 'input', title: 'Value', placeholder: 'hint' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(request!.mode, 'form'); assert.ok('sessionId' in request!); assert.equal(request.sessionId, 's');
  assert.deepEqual(replies, [{ type: 'extension_ui_response', id: 'provider-id', value: 'value' }]);
});

test('cancellation and timeout retire exactly once and ignore late responses', async () => {
  const replies: Record<string, unknown>[] = [];
  let answer!: (r: CreateElicitationResponse) => void;
  const bridge = new Interactions('s', { createElicitation: () => new Promise(r => { answer = r; }) }, true,
    async r => { replies.push(r); }, () => {}, () => {});
  bridge.receive({ type: 'extension_ui_request', id: 'a', method: 'editor', title: 'Edit', prefill: 'a\nb', timeout: 10 });
  await new Promise(resolve => setTimeout(resolve, 20));
  await bridge.cancelAll(); answer({ action: 'accept', content: { answer: 'late' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(replies, [{ type: 'extension_ui_response', id: 'a', cancelled: true }]);
});

test('unsupported dialogs cancel; notifications create no pending questions', async () => {
  const replies: Record<string, unknown>[] = [];
  const bridge = new Interactions('s', { createElicitation: async () => { throw new Error('must not run'); } }, false,
    async r => { replies.push(r); }, () => {}, () => {});
  bridge.receive({ type: 'extension_ui_request', id: 'n', method: 'notify', message: 'hello' });
  bridge.receive({ type: 'extension_ui_request', id: 'q', method: 'select', title: 'Choose', options: ['yes', 'no'] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(replies, [{ type: 'extension_ui_response', id: 'q', cancelled: true }]);
  assert.equal(bridge.size, 0);
});

test('malformed option answers, duplicates and declines never revive retired requests', async () => {
  const replies: Record<string, unknown>[] = [];
  const bridge = new Interactions('s', { createElicitation: async () => ({ action: 'accept', content: { answer: 'not-an-option' } }) }, true,
    async r => { replies.push(r); }, () => {}, () => {});
  const event = { type: 'extension_ui_request', id: 'q', method: 'select', title: 'Choose', options: ['one', 'two'] };
  bridge.receive(event); bridge.receive(event);
  await new Promise(resolve => setImmediate(resolve)); bridge.receive(event);
  assert.deepEqual(replies, [{ type: 'extension_ui_response', id: 'q', cancelled: true }]);
});

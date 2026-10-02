#!/usr/bin/env node
// Sanitized, independently written Pi 0.99.1 protocol behavior fixture.
import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
if (args.includes('--version')) { console.log(process.env.PI_ACP_FIXTURE_VERSION ?? '0.99.1'); process.exit(Number(process.env.PI_ACP_FIXTURE_VERSION_EXIT ?? 0)); }
if (process.env.PI_ACP_FIXTURE_PID_FILE) writeFileSync(process.env.PI_ACP_FIXTURE_PID_FILE, String(process.pid));
const option = name => args[args.indexOf(name) + 1];
const cwd = process.cwd();
let sessionId = args.includes('--session-id') ? option('--session-id') : 'fixture';
const path = args.includes('--session') ? option('--session') : join(option('--session-dir'), `${sessionId}.jsonl`);
mkdirSync(dirname(path), { recursive: true });
let entries = [];
if (args.includes('--session')) {
  const records = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
  sessionId = records[0].id; entries = records.slice(1);
} else writeFileSync(path, JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd, timestamp: new Date().toISOString() }) + '\n');
let streaming = false;
let model = { provider: 'fixture', id: 'model', name: 'Fixture' };
let thinking = 'off';
let cancelRun;
let question;
let sessionName = entries.filter(e => e.type === 'session_info').at(-1)?.name;
let staleNameSnapshot = false;
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const response = (request, data) => emit({ type: 'response', id: request.id, command: request.type, success: true, ...(data === undefined ? {} : { data }) });
const append = message => {
  const entry = { type: message.role === 'custom' ? 'custom_message' : 'message', id: randomUUID(), parentId: entries.at(-1)?.id ?? null, timestamp: new Date().toISOString(),
    ...(message.role === 'custom' ? { content: message.content, display: message.display, customType: 'fixture' } : { message }) };
  entries.push(entry); appendFileSync(path, JSON.stringify(entry) + '\n');
};
const setName = name => {
  sessionName = name.replace(/[\r\n]+/g, ' ').trim() || undefined;
  const entry = { type: 'session_info', id: randomUUID(), parentId: entries.at(-1)?.id ?? null,
    timestamp: new Date().toISOString(), name: sessionName ?? '' };
  entries.push(entry); appendFileSync(path, JSON.stringify(entry) + '\n');
  emit({ type: 'session_info_changed', ...(sessionName ? { name: sessionName } : {}) });
};
const endMessage = message => { emit({ type: 'message_end', message }); append(message); };
const fullMessage = message => { emit({ type: 'message_start', message }); endMessage(message); };
const settled = () => { streaming = false; cancelRun = undefined; emit({ type: 'agent_end', messages: [], willRetry: false }); emit({ type: 'agent_settled' }); };
function run(request, fast = false) {
  streaming = true;
  if (!fast) response(request, { disposition: 'started' });
  emit({ type: 'agent_start' });
  fullMessage({ role: 'user', content: request.message });
  const text = request.message === 'unicode' ? 'Hello 🦊\u2028\u2029' : 'Hello';
  emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text } });
  const finish = stopReason => {
    endMessage({ role: 'assistant', content: [{ type: 'text', text }], stopReason }); settled();
  };
  if (request.message === 'stuck') cancelRun = () => {};
  else if (request.message === 'wait') cancelRun = () => finish('aborted');
  else if (request.message === 'retry-exhausted') { emit({ type: 'auto_retry_end', success: false, attempt: 3 }); finish('error'); }
  else if (request.message === 'compaction-error') {
    emit({ type: 'compaction_start', reason: 'overflow' });
    emit({ type: 'compaction_end', reason: 'overflow', aborted: false, willRetry: false, errorMessage: 'fixture failure' }); finish('error');
  } else if (request.message === 'compaction') {
    endMessage({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'error' });
    emit({ type: 'agent_end', messages: [], willRetry: true }); emit({ type: 'compaction_start', reason: 'overflow' });
    setTimeout(() => {
      emit({ type: 'compaction_end', reason: 'overflow', result: {}, aborted: false, willRetry: true });
      emit({ type: 'agent_start' });
      fullMessage({ role: 'assistant', content: [{ type: 'text', text: 'Compacted and recovered' }], stopReason: 'stop' }); settled();
    }, 30);
  }
  else if (request.message === 'retry') {
    endMessage({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'error' });
    emit({ type: 'agent_end', messages: [], willRetry: true }); emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 2, delayMs: 30 });
    setTimeout(() => {
      emit({ type: 'agent_start' });
      fullMessage({ role: 'assistant', content: [{ type: 'thinking', thinking: 'recovering' }, { type: 'text', text: 'Recovered' }], stopReason: 'stop' });
      emit({ type: 'auto_retry_end', success: true, attempt: 1 }); settled();
    }, 30);
  } else if (request.message === 'tools' || request.message === 'large-tools') {
    const large = request.message === 'large-tools';
    const toolId = randomUUID();
    const toolName = large ? 'write' : 'bash';
    const args = large ? { path: 'large.txt', content: '\0"🦊\n'.repeat(50_000) } : { command: 'false' };
    endMessage({ role: 'assistant', content: [{ type: 'text', text }, { type: 'thinking', thinking: 'check' },
      { type: 'toolCall', id: toolId, name: toolName, arguments: args }, { type: 'text', text: 'after' }], stopReason: 'toolUse' });
    emit({ type: 'tool_execution_start', toolCallId: toolId, toolName, args });
    for (const text of ['a', 'ab']) emit({ type: 'tool_execution_update', toolCallId: toolId, partialResult: { content: [{ type: 'text', text }] } });
    const result = { content: [{ type: 'text', text: large ? '\0'.repeat(150_000) : 'Command failed' }] };
    emit({ type: 'tool_execution_end', toolCallId: toolId, isError: !large, result });
    fullMessage({ role: 'toolResult', toolCallId: toolId, toolName, isError: !large, ...result });
    fullMessage({ role: 'assistant', content: [{ type: 'text', text: 'Done' }], stopReason: 'stop' }); settled();
  } else finish(request.message === 'tokens' ? 'length' : request.message === 'error' ? 'error' : 'stop');
  if (fast) response(request, { disposition: 'started' });
}

createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.type === 'extension_ui_response') {
    if (question && question.id === request.id) { const q = question; question = undefined; q.resolve(request); }
    return;
  }
  if (request.type === 'get_state' && args.includes('--startup-wait')) return;
  if (request.type === 'get_state') {
    const state = { sessionId, sessionFile: path, sessionName, model, thinkingLevel: thinking,
      isStreaming: streaming, isCompacting: false, pendingMessageCount: 0 };
    if (staleNameSnapshot) {
      staleNameSnapshot = false; setName('Newest title');
      setTimeout(() => response(request, state), 10);
    } else response(request, state);
  }
  else if (request.type === 'get_entries') {
    const index = request.since ? entries.findIndex(e => e.id === request.since) + 1 : 0;
    response(request, { entries: entries.slice(index), leafId: entries.at(-1)?.id ?? null });
  } else if (request.type === 'get_available_models') response(request, { models: [model, { provider: 'fixture', id: 'other', name: 'Other' }] });
  else if (request.type === 'get_available_thinking_levels') response(request, { levels: ['off', 'high'] });
  else if (request.type === 'get_commands') response(request, { commands: [{ name: 'question', source: 'extension', description: 'Ask a question' },
    ...(process.env.PI_ACP_FIXTURE_NAME_COMMAND ? [{ name: 'name', source: 'extension', description: 'Extension name command' }] : [])] });
  else if (request.type === 'get_session_stats') response(request, { contextUsage: { tokens: 12, contextWindow: 1024 } });
  else if (request.type === 'set_model') { model = { provider: request.provider, id: request.modelId }; response(request, model); }
  else if (request.type === 'set_thinking_level') { thinking = request.level; response(request); }
  else if (request.type === 'set_session_name') { setName(request.name); response(request); }
  else if (request.type === 'prompt') {
    if (request.message === 'crash') process.exit(8);
    if (request.message === '/handled') response(request, { disposition: 'handled' });
    else if (request.message === '/late-name') { response(request, { disposition: 'handled' }); setTimeout(() => setName('Background title 🦊'), 100); }
    else if (request.message === '/clear-name') { setName(''); response(request, { disposition: 'handled' }); }
    else if (request.message === '/name-race') { staleNameSnapshot = true; response(request, { disposition: 'handled' }); }
    else if (process.env.PI_ACP_FIXTURE_NAME_COMMAND && request.message.startsWith('/name ')) { setName(`Extension: ${request.message.slice(6)}`); response(request, { disposition: 'handled' }); }
    else if (request.message === '/extension-error') { emit({ type: 'extension_error', error: 'fixture error' }); response(request, { disposition: 'handled' }); }
    else if (request.message === '/switch') { sessionId = 'changed'; response(request, { disposition: 'handled' }); }
    else if (request.message === '/question') {
      const id = randomUUID();
      question = { id, resolve: answer => {
        fullMessage({ role: 'custom', content: [{ type: 'text', text: answer.cancelled ? 'Cancelled' : answer.value }], display: true });
        response(request, { disposition: 'handled' });
      } };
      emit({ type: 'extension_ui_request', id, method: 'input', title: 'Choose value', placeholder: 'value' });
    } else run(request, request.message === 'fast');
  } else if (request.type === 'abort') { if (cancelRun) cancelRun(); response(request); }
  else response(request);
});

// Deterministic model fixture inside an actual installed Pi process. No network.
import { createAssistantMessageEventStream, Type } from '@earendil-works/pi-ai';

export default function fixture(pi) {
  pi.registerCommand('fixture-question', {
    description: 'Ask an extension-only question',
    handler: async (_args, ctx) => {
      const value = await ctx.ui.input('Fixture question', 'Enter a value');
      await pi.sendMessage({ customType: 'fixture', display: true, content: [{ type: 'text', text: value ?? 'Cancelled' }] });
    },
  });
  pi.registerCommand('fixture-handled', { description: 'Complete without a model run', handler: async () => {} });
  pi.registerCommand('fixture-name', { description: 'Set or clear a name through an extension', handler: async args => { pi.setSessionName(args); } });
  pi.registerCommand('fixture-background-name', { description: 'Set a name after command settlement', handler: async () => {
    setTimeout(() => pi.setSessionName('Background title 🦊'), 100);
  } });
  pi.registerTool({ name: 'fixture_question', label: 'Fixture question', description: 'Ask a question', parameters: Type.Object({}),
    execute: async (_id, _params, _signal, _update, ctx) => {
      const answer = await ctx.ui.select('Pick a value', ['one', 'two']);
      return { content: [{ type: 'text', text: answer ?? 'Cancelled' }], details: {} };
    } });
  pi.registerProvider('pi-acp-fixture', {
    baseUrl: 'https://fixture.invalid', apiKey: 'fixture-not-a-secret', api: 'pi-acp-fixture-api',
    models: [{ id: 'fixture', name: 'ACP fixture', reasoning: true, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        content: [], usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 25,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop' };
      const latestUser = [...context.messages].reverse().find(m => m.role === 'user');
      const task = typeof latestUser?.content === 'string' ? latestUser.content : latestUser?.content?.filter(b => b.type === 'text').map(b => b.text).join('');
      const last = context.messages.at(-1);
      queueMicrotask(() => {
        stream.push({ type: 'start', partial: message });
        if (task === 'wait') {
          const abort = () => { message.stopReason = 'aborted'; stream.push({ type: 'error', reason: 'aborted', error: message }); stream.end(); };
          if (options?.signal?.aborted) abort(); else options?.signal?.addEventListener('abort', abort, { once: true });
          return;
        }
        if (task === 'provider failure') {
          message.stopReason = 'error'; message.errorMessage = 'Non-retryable fixture failure';
          stream.push({ type: 'error', reason: 'error', error: message }); stream.end(); return;
        }
        let calls = [];
        if (last?.role !== 'toolResult') {
          if (task === 'exercise tools') calls = [
            ['read', { path: 'sample.txt' }], ['write', { path: 'created.txt', content: 'created\n' }],
            ['edit', { path: 'sample.txt', edits: [{ oldText: 'before', newText: 'after' }] }],
            ['bash', { command: "printf 'fixture output'" }],
          ];
          else if (task === 'question') calls = [['fixture_question', {}]];
          else if (task === 'failed tool') calls = [['bash', { command: 'exit 7' }]];
        }
        if (calls.length) {
          message.stopReason = 'toolUse';
          for (const [name, args] of calls) {
            const contentIndex = message.content.length;
            const call = { type: 'toolCall', id: `fixture-${Date.now()}-${contentIndex}`, name, arguments: args };
            message.content.push(call);
            stream.push({ type: 'toolcall_start', contentIndex, partial: message });
            stream.push({ type: 'toolcall_delta', contentIndex, delta: JSON.stringify(args), partial: message });
            stream.push({ type: 'toolcall_end', contentIndex, toolCall: call, partial: message });
          }
        } else {
          message.content.push({ type: 'thinking', thinking: 'fixture thought' });
          stream.push({ type: 'thinking_start', contentIndex: 0, partial: message });
          stream.push({ type: 'thinking_delta', contentIndex: 0, delta: 'fixture thought', partial: message });
          stream.push({ type: 'thinking_end', contentIndex: 0, content: 'fixture thought', partial: message });
          const text = 'Fixture complete 🦊';
          message.content.push({ type: 'text', text });
          stream.push({ type: 'text_start', contentIndex: 1, partial: message });
          stream.push({ type: 'text_delta', contentIndex: 1, delta: text, partial: message });
          stream.push({ type: 'text_end', contentIndex: 1, content: text, partial: message });
        }
        stream.push({ type: 'done', reason: message.stopReason, message }); stream.end();
      });
      return stream;
    },
  });
}

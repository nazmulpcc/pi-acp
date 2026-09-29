import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { SessionUpdate, ToolCallContent, ToolKind } from '@agentclientprotocol/sdk';
import { boundedText, limits, truncate } from '../limits.js';
import { object, type PiRecord } from '../pi/records.js';

const blockSchema = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('text'), text: z.string() }),
  z.looseObject({ type: z.literal('thinking'), thinking: z.string() }),
  z.looseObject({ type: z.literal('toolCall'), id: z.string(), name: z.string(), arguments: z.record(z.string(), z.unknown()) }),
  z.looseObject({ type: z.literal('image'), data: z.string(), mimeType: z.string() }),
]);
const messageSchema = z.looseObject({
  role: z.enum(['user', 'assistant', 'toolResult', 'custom', 'system', 'bashExecution', 'compactionSummary', 'branchSummary']),
  content: z.union([z.string(), z.array(blockSchema)]).optional(),
  toolCallId: z.string().optional(), toolName: z.string().optional(), isError: z.boolean().optional(),
  stopReason: z.string().optional(), display: z.boolean().optional(),
});
export type Message = z.infer<typeof messageSchema>;
export type Block = z.infer<typeof blockSchema>;
export interface FinalizedMessage { message: Message; id: string }

export function decodeMessage(value: unknown): Message {
  const result = messageSchema.safeParse(value);
  if (!result.success) throw new Error('Invalid Pi message shape');
  if (Buffer.byteLength(JSON.stringify(result.data)) > limits.turnBytes) throw new Error('Pi message exceeds retained-state limit');
  return result.data;
}
function blocks(message: Message): Block[] {
  return typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? [];
}
function kind(name: string): ToolKind {
  return ({ read: 'read', edit: 'edit', write: 'edit', bash: 'execute', grep: 'search', find: 'search', ls: 'read' } as const)[name as 'read'] ?? 'other';
}
function locations(name: string, args: Record<string, unknown>, cwd: string) {
  return ['read', 'edit', 'write', 'grep', 'find', 'ls'].includes(name) && typeof args.path === 'string'
    ? [{ path: resolve(cwd, args.path) }] : [];
}
function toolContent(value: unknown): ToolCallContent[] {
  const result = object(value);
  const content: ToolCallContent[] = [];
  let remaining = limits.outputBytes;
  if (Array.isArray(result.content)) for (const item of result.content) {
    const block = object(item);
    if (block.type === 'text' && typeof block.text === 'string' && remaining > 64) {
      const text = truncate(block.text, remaining);
      remaining -= Buffer.byteLength(text);
      content.push({ type: 'content', content: { type: 'text', text } });
    } else if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string' &&
               Buffer.byteLength(block.data) <= remaining) {
      remaining -= Buffer.byteLength(block.data);
      content.push({ type: 'content', content: { type: 'image', data: block.data, mimeType: block.mimeType } });
    }
  }
  // Pi's unified patch is authoritative; do not infer whole-file old contents.
  if (result.details && typeof result.details === 'object') {
    const details = object(result.details);
    if (typeof details.patch === 'string') content.push({
      type: 'content', content: { type: 'text', text: truncate(details.patch, limits.previewBytes) },
    });
  }
  return content;
}

interface LiveMessage { id: string; role: string; texts: Map<number, string>; args: Map<number, string>; tools: Map<number, string> }
interface Tool { acpId: string; name: string; args: Record<string, unknown>; done: boolean }

/** Stateful reconstruction, pure with respect to I/O. Live and replay share projection. */
export class Transcript {
  private current = new Map<string, LiveMessage>();
  private tools = new Map<string, Tool>();
  private bytes = 0;
  readonly finalized: FinalizedMessage[] = [];
  constructor(private readonly cwd: string, private readonly emit: (update: SessionUpdate) => void,
              private readonly allocate: () => string = randomUUID) {}

  event(event: PiRecord): void {
    const scope = typeof event.parentToolCallId === 'string' ? event.parentToolCallId : '';
    if (event.type === 'message_start') {
      if (this.current.has(scope)) throw new Error('Overlapping Pi message boundary');
      const message = decodeMessage(event.message);
      const live: LiveMessage = { id: this.allocate(), role: message.role, texts: new Map(), args: new Map(), tools: new Map() };
      this.current.set(scope, live);
      // User and extension messages can begin with complete content.
      if (message.role !== 'assistant' && message.role !== 'toolResult') this.reconcile(live, message);
    } else if (event.type === 'message_update') {
      const live = this.current.get(scope);
      if (!live) throw new Error('Pi message update without start');
      const delta = object(event.assistantMessageEvent);
      const index = delta.contentIndex;
      if (delta.type === 'start' || delta.type === 'done' || delta.type === 'error') return;
      if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) > 4096) throw new Error('Invalid content index');
      const i = index as number;
      if (delta.type === 'text_delta' || delta.type === 'thinking_delta') {
        const text = boundedText(delta.delta, limits.turnBytes, 'message delta');
        this.text(live, i, live.texts.get(i) ?? '', text, delta.type === 'thinking_delta');
      } else if (delta.type === 'text_end' || delta.type === 'thinking_end') {
        const text = boundedText(delta.content, limits.turnBytes, 'final content');
        this.finalText(live, i, text, delta.type === 'thinking_end');
      } else if (delta.type === 'toolcall_start') {
        const id = boundedText(delta.id, 1024, 'tool id');
        const name = boundedText(delta.toolName, 1024, 'tool name');
        live.tools.set(i, id);
        this.startTool(live.id, id, name, {}, scope);
      } else if (delta.type === 'toolcall_delta') {
        const text = boundedText(delta.delta, limits.turnBytes, 'tool arguments');
        this.retain(Buffer.byteLength(text));
        live.args.set(i, (live.args.get(i) ?? '') + text);
      } else if (delta.type === 'toolcall_end') {
        const call = blockSchema.parse(delta.toolCall);
        if (call.type !== 'toolCall') throw new Error('Invalid final tool call');
        this.startTool(live.id, call.id, call.name, call.arguments, scope);
      }
    } else if (event.type === 'message_end') {
      const live = this.current.get(scope);
      if (!live) throw new Error('Pi message end without start');
      const message = decodeMessage(event.message);
      if (message.role !== live.role) throw new Error('Pi message role changed');
      this.reconcile(live, message);
      this.finalized.push({ message, id: live.id });
      this.current.delete(scope);
    } else if (event.type.startsWith('tool_execution_')) {
      const id = boundedText(event.toolCallId, 1024, 'tool id');
      if (event.type === 'tool_execution_start') {
        const name = boundedText(event.toolName, 1024, 'tool name');
        const args = object(event.args);
        this.startTool(this.allocate(), id, name, args, scope);
        this.emit({ sessionUpdate: 'tool_call_update', toolCallId: this.tools.get(id)!.acpId, status: 'in_progress' });
      } else if (event.type === 'tool_execution_update' || event.type === 'tool_execution_end') {
        const tool = this.tools.get(id);
        if (!tool) throw new Error('Pi result without tool identity');
        if (event.type === 'tool_execution_end' && typeof event.isError !== 'boolean') throw new Error('Invalid tool outcome');
        this.result(id, event.type === 'tool_execution_end' ? event.result : event.partialResult,
          event.type === 'tool_execution_end' ? (event.isError ? 'failed' : 'completed') : 'in_progress');
      }
    }
  }

  replay(message: Message, id: string): void {
    const live: LiveMessage = { id, role: message.role, texts: new Map(), args: new Map(), tools: new Map() };
    this.reconcile(live, message);
  }

  finishTools(): void {
    for (const tool of this.tools.values()) if (!tool.done) {
      tool.done = true;
      this.emit({ sessionUpdate: 'tool_call_update', toolCallId: tool.acpId, status: 'failed',
        content: [{ type: 'content', content: { type: 'text', text: 'Tool did not complete before the turn ended.' } }] });
    }
  }

  private retain(size: number): void {
    this.bytes += size;
    if (this.bytes > limits.turnBytes) throw new Error('Turn exceeds retained-state limit');
  }
  private text(live: LiveMessage, index: number, old: string, text: string, thought: boolean): void {
    this.retain(Buffer.byteLength(text));
    live.texts.set(index, old + text);
    if (text) this.emit({ sessionUpdate: live.role === 'user' ? 'user_message_chunk' : thought ? 'agent_thought_chunk' : 'agent_message_chunk',
      messageId: `${live.id}/block/${index}`, content: { type: 'text', text } });
  }
  private finalText(live: LiveMessage, index: number, final: string, thought: boolean): void {
    const old = live.texts.get(index) ?? '';
    if (!final.startsWith(old)) throw new Error('Final Pi text revises emitted content; ACP cannot retract chunks');
    this.text(live, index, old, final.slice(old.length), thought);
  }
  private reconcile(live: LiveMessage, message: Message): void {
    if (message.role === 'system' || (message.role === 'custom' && !message.display)) return;
    if (message.role === 'toolResult') {
      if (!message.toolCallId) throw new Error('Tool result missing identity');
      if (!this.tools.get(message.toolCallId)?.done) this.result(message.toolCallId, message, message.isError ? 'failed' : 'completed');
      return;
    }
    blocks(message).forEach((block, index) => {
      if (block.type === 'text') this.finalText(live, index, block.text, false);
      else if (block.type === 'thinking') this.finalText(live, index, block.thinking, true);
      else if (block.type === 'toolCall') this.startTool(live.id, block.id, block.name, block.arguments, '');
      else if (block.type === 'image') this.emit({ sessionUpdate: message.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
        messageId: `${live.id}/block/${index}`, content: { type: 'image', data: block.data, mimeType: block.mimeType } });
    });
    if (message.role === 'bashExecution' && typeof message.output === 'string') {
      const id = `bash/${live.id}`;
      this.startTool(live.id, id, 'bash', { command: message.command }, '');
      this.result(id, { content: [{ type: 'text', text: message.output }] }, message.cancelled || message.exitCode !== 0 ? 'failed' : 'completed');
    }
  }
  private startTool(owner: string, id: string, name: string, args: Record<string, unknown>, parent: string): void {
    const existing = this.tools.get(id);
    if (existing) {
      if (existing.name !== name) throw new Error('Pi tool name changed');
      existing.args = args;
      this.emit({ sessionUpdate: 'tool_call_update', toolCallId: existing.acpId, rawInput: args, locations: locations(name, args, this.cwd) });
      return;
    }
    const tool: Tool = { acpId: `${owner}/tool/${id}`, name, args, done: false };
    this.tools.set(id, tool);
    this.emit({ sessionUpdate: 'tool_call', toolCallId: tool.acpId, name, title: name, kind: kind(name), status: 'pending',
      rawInput: args, locations: locations(name, args, this.cwd),
      ...(parent ? { _meta: { parentToolCallId: this.tools.get(parent)?.acpId ?? parent } } : {}) });
  }
  private result(id: string, result: unknown, status: 'completed' | 'failed' | 'in_progress'): void {
    const tool = this.tools.get(id);
    if (!tool) throw new Error('Tool result has no preceding call');
    if (tool.done) return;
    tool.done = status !== 'in_progress';
    this.emit({ sessionUpdate: 'tool_call_update', toolCallId: tool.acpId, status, content: toolContent(result) });
  }
}

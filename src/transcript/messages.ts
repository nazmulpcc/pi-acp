import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { SessionUpdate, ToolCallContent, ToolKind } from '@agentclientprotocol/sdk';
import { boundedText, limits, truncate } from '../limits.js';
import { object, type PiRecord } from '../pi/records.js';
import { notificationBytes } from '../acp-wire.js';

const blockSchema = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('text'), text: z.string() }),
  z.looseObject({ type: z.literal('thinking'), thinking: z.string() }),
  z.looseObject({ type: z.literal('toolCall'), id: z.string().max(1024), name: z.string().max(1024), arguments: z.record(z.string(), z.unknown()) }),
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
  const kinds: Record<string, ToolKind> = { read: 'read', edit: 'edit', write: 'edit', bash: 'execute', grep: 'search', find: 'search', ls: 'read' };
  return kinds[name] ?? 'other';
}
function displayText(text: string, max: number): string {
  let result = truncate(text, max);
  while (Buffer.byteLength(JSON.stringify(result)) > max) {
    result = truncate(result, Math.floor(Buffer.byteLength(result) / 2));
  }
  return result;
}
function toolPath(args: Record<string, unknown>, cwd: string): string | undefined {
  if (typeof args.path !== 'string' || Buffer.byteLength(args.path) > 4096) return undefined;
  const path = resolve(cwd, args.path);
  return Buffer.byteLength(path) <= 4096 ? path : undefined;
}
function locations(name: string, args: Record<string, unknown>, cwd: string) {
  const path = ['read', 'edit', 'write', 'grep', 'find', 'ls'].includes(name) ? toolPath(args, cwd) : undefined;
  return path ? [{ path }] : [];
}
function toolContent(value: unknown): ToolCallContent[] {
  const result = object(value);
  const content: ToolCallContent[] = [];
  let remaining = limits.outputBytes;
  if (Array.isArray(result.content)) for (const item of result.content) {
    const block = object(item);
    if (block.type === 'text' && typeof block.text === 'string' && remaining > 64) {
      const text = displayText(block.text, remaining - 64);
      remaining -= Buffer.byteLength(JSON.stringify(text)) + 64;
      content.push({ type: 'content', content: { type: 'text', text } });
    } else if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string' &&
               Buffer.byteLength(block.data) <= remaining) {
      remaining -= Buffer.byteLength(block.data);
      content.push({ type: 'content', content: { type: 'image', data: block.data, mimeType: block.mimeType } });
    }
  }
  return content;
}

/** Keep a UTF-8 prefix; machine-readable previews never contain fabricated suffixes. */
function previewText(text: string, max: number): { text: string; truncated: boolean } {
  let end = text.length;
  while (Buffer.byteLength(JSON.stringify(text.slice(0, end))) > max) end = Math.floor(end / 2);
  if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--;
  return { text: text.slice(0, end), truncated: end !== text.length };
}

type ToolUpdate = Extract<SessionUpdate, { sessionUpdate: 'tool_call' | 'tool_call_update' }>;

/** Shared budget includes arguments, previews, content, IDs, envelope and final LF. */
export function boundToolUpdate(original: ToolUpdate, sessionId: string): ToolUpdate {
  const update = { ...original };
  if (notificationBytes(sessionId, update) <= limits.outputBytes) return update;
  if (update.rawInput !== undefined) {
    delete update.rawInput;
    update._meta = { ...update._meta, inputOmitted: 'Tool arguments exceed complete notification limit' };
  }
  if (notificationBytes(sessionId, update) <= limits.outputBytes) return update;
  const content = update.content ?? [];
  update._meta = { ...update._meta, outputTruncated: true };
  update.content = [];
  let remaining = limits.outputBytes - notificationBytes(sessionId, update);
  if (remaining < 128) throw new Error('Tool identity or preview exceeds complete notification limit');
  for (const item of content) {
    const size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (size <= remaining) { update.content.push(item); remaining -= size; }
    else if (item.type === 'content' && item.content.type === 'text' && remaining > 128) {
      const text = displayText(item.content.text, remaining - 128);
      update.content.push({ type: 'content', content: { type: 'text', text } });
      remaining -= Buffer.byteLength(JSON.stringify(update.content.at(-1))) + 1;
    } else if (item.type === 'content' && item.content.type === 'image' && remaining > 128) {
      const omitted: ToolCallContent = { type: 'content', content: { type: 'text', text: '[Tool image omitted: exceeds complete notification limit.]' } };
      update.content.push(omitted); remaining -= Buffer.byteLength(JSON.stringify(omitted)) + 1;
    }
    if (remaining < 128) break;
  }
  if (notificationBytes(sessionId, update) > limits.outputBytes) throw new Error('Tool notification exceeds wire budget');
  return update;
}

interface LiveMessage { id: string; role: string; texts: Map<number, string>; args: Map<number, string>; tools: Map<number, string>; images: Set<number> }
interface Tool { acpId: string; name: string; args: Record<string, unknown>; done: boolean }

/** Stateful reconstruction, pure with respect to I/O. Live and replay share projection. */
export class Transcript {
  private current = new Map<string, LiveMessage>();
  private tools = new Map<string, Tool>();
  private bytes = 0;
  readonly finalized: FinalizedMessage[] = [];
  constructor(private readonly cwd: string, private readonly emit: (update: SessionUpdate) => void,
              private readonly allocate: () => string = randomUUID, private readonly sessionId = '') {}

  private tool(update: ToolUpdate): void { this.emit(boundToolUpdate(update, this.sessionId)); }

  event(event: PiRecord): void {
    const scope = event.parentToolCallId == null ? '' : boundedText(event.parentToolCallId, 1024, 'parent tool id');
    if (event.type === 'message_start') {
      if (this.current.has(scope)) throw new Error('Overlapping Pi message boundary');
      const message = decodeMessage(event.message);
      if (this.current.size >= 16) throw new Error('Too many simultaneous Pi messages');
      const live: LiveMessage = { id: this.allocate(), role: message.role, texts: new Map(), args: new Map(), tools: new Map(), images: new Set() };
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
      this.retain(Buffer.byteLength(JSON.stringify(message)));
      if (this.finalized.length >= 4096) throw new Error('Too many messages in one turn');
      this.finalized.push({ message, id: live.id });
      this.current.delete(scope);
    } else if (event.type.startsWith('tool_execution_')) {
      const id = boundedText(event.toolCallId, 1024, 'tool id');
      if (event.type === 'tool_execution_start') {
        const name = boundedText(event.toolName, 1024, 'tool name');
        const args = object(event.args);
        this.startTool(this.allocate(), id, name, args, scope);
        this.tool({ sessionUpdate: 'tool_call_update', toolCallId: this.tools.get(id)!.acpId, title: name, kind: kind(name), status: 'in_progress' });
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
    const live: LiveMessage = { id, role: message.role, texts: new Map(), args: new Map(), tools: new Map(), images: new Set() };
    this.reconcile(live, message);
  }

  finishTools(): void {
    for (const tool of this.tools.values()) if (!tool.done) {
      tool.done = true;
      this.tool({ sessionUpdate: 'tool_call_update', toolCallId: tool.acpId, title: tool.name, kind: kind(tool.name), status: 'failed',
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
    // Replay and authoritative whole messages also obey the individual update bound.
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + 16_384, text.length);
      if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--;
      this.emit({ sessionUpdate: live.role === 'user' ? 'user_message_chunk' : thought ? 'agent_thought_chunk' : 'agent_message_chunk',
        messageId: `${live.id}/block/${index}`, content: { type: 'text', text: text.slice(start, end) } });
      start = end;
    }
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
      else if (block.type === 'image' && !live.images.has(index)) {
        live.images.add(index);
        this.emit({ sessionUpdate: message.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
          messageId: `${live.id}/block/${index}`, content: Buffer.byteLength(block.data) <= limits.outputBytes
            ? { type: 'image', data: block.data, mimeType: block.mimeType }
            : { type: 'text', text: '[Image omitted from transcript: exceeds 512 KiB display limit.]' } });
      }
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
      this.tool({ sessionUpdate: 'tool_call_update', toolCallId: existing.acpId, title: name, kind: kind(name), ...this.input(args), locations: locations(name, args, this.cwd) });
      return;
    }
    const tool: Tool = { acpId: `${owner}/tool/${id}`, name, args, done: false };
    if (this.tools.size >= 4096) throw new Error('Too many tools in one turn');
    this.retain(Buffer.byteLength(JSON.stringify(args)) + id.length + name.length + 128);
    this.tools.set(id, tool);
    const input = this.input(args);
    this.tool({ sessionUpdate: 'tool_call', toolCallId: tool.acpId, name, title: name, kind: kind(name), status: 'pending',
      ...input, locations: locations(name, args, this.cwd),
      ...(parent ? { _meta: { ...('_meta' in input ? input._meta : {}), parentToolCallId: this.tools.get(parent)?.acpId ?? parent } } : {}) });
  }
  private result(id: string, result: unknown, status: 'completed' | 'failed' | 'in_progress'): void {
    const tool = this.tools.get(id);
    if (!tool) throw new Error('Tool result has no preceding call');
    if (tool.done) return;
    tool.done = status !== 'in_progress';
    const content: ToolCallContent[] = [];
    let rawOutput: { path: string; patch?: string; newText?: string; truncated: boolean } | undefined;
    const path = toolPath(tool.args, this.cwd);
    const details = object(result).details;
    const patch = details && typeof details === 'object' && !Array.isArray(details) ? object(details).patch : undefined;
    if (status === 'completed' && path && (tool.name === 'write' && typeof tool.args.content === 'string' || tool.name === 'edit' && typeof patch === 'string')) {
      const value = tool.name === 'write' ? tool.args.content as string : patch as string;
      const preview = previewText(value, limits.previewBytes - Buffer.byteLength(JSON.stringify(path)) - 128);
      rawOutput = { path, ...(tool.name === 'write' ? { newText: preview.text } : { patch: preview.text }), truncated: preview.truncated };
      content.push({ type: 'content', content: { type: 'text', text: `${tool.name === 'write' ? 'Requested file content:\n' : ''}${preview.text}${preview.truncated ? '\n[Preview truncated by adapter]' : ''}` } });
    }
    content.push(...toolContent(result));
    this.tool({ sessionUpdate: 'tool_call_update', toolCallId: tool.acpId, title: tool.name, kind: kind(tool.name), status, content,
      ...(rawOutput ? { rawOutput } : {}) });
  }
  private input(args: Record<string, unknown>) {
    return Buffer.byteLength(JSON.stringify(args)) <= limits.outputBytes ? { rawInput: args } : { _meta: { inputOmitted: 'Tool arguments exceed display limit' } };
  }
}

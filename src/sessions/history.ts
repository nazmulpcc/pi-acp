import { z } from 'zod';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { limits } from '../limits.js';
import { decodeMessage, Transcript, TranscriptLimitError, type Message } from '../transcript/messages.js';
import { RecordReader } from '../pi/records.js';
import { openRegular } from './files.js';
import { notificationBytes } from '../acp-wire.js';

const entrySchema = z.looseObject({ type: z.string(), id: z.string().max(1024), parentId: z.string().max(1024).nullable(), timestamp: z.string() });
const headerSchema = z.looseObject({ type: z.literal('session'), version: z.literal(3), id: z.string().max(1024), cwd: z.string(), timestamp: z.string() });
export type Entry = z.infer<typeof entrySchema>;
export type Header = z.infer<typeof headerSchema>;
export interface History { header: Header; entries: Entry[]; leafId: string | null }

export async function readHistory(path: string): Promise<History> {
  const handle = await openRegular(path, limits.historyFileBytes);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limits.historyFileBytes) throw new Error('Session file is not regular or exceeds history limit');
    const entries: Entry[] = [];
    let header: Header | undefined;
    let bytes = 0;
    const reader = new RecordReader(value => {
      if (!header) header = headerSchema.parse(value);
      else entries.push(entrySchema.parse(value));
      if (entries.length > limits.historyEntries) throw new Error('Too many session entries');
    });
    const block = Buffer.alloc(64 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(block, 0, block.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > limits.historyFileBytes) throw new Error('Session grew beyond history limit');
      reader.push(block.subarray(0, bytesRead));
    }
    try { reader.end(); } catch { throw new Error('Incomplete session file; retry after Pi finishes writing'); }
    if (!header) throw new Error('Missing Pi session header');
    return { header, entries, leafId: entries.at(-1)?.id ?? null };
  } finally { await handle.close(); }
}

export function activeBranch(entries: Entry[], leafId: string | null): Entry[] {
  const byId = new Map<string, Entry>();
  for (const entry of entries) {
    if (byId.has(entry.id)) throw new Error('Duplicate session entry id');
    byId.set(entry.id, entry);
  }
  const branch: Entry[] = [];
  const visited = new Set<string>();
  let id = leafId;
  while (id !== null) {
    if (visited.has(id)) throw new Error('Session parent cycle');
    visited.add(id);
    const entry = byId.get(id);
    if (!entry) throw new Error('Session parent or leaf missing');
    branch.push(entry);
    id = entry.parentId;
  }
  return branch.reverse();
}

export interface HistoryProjection { updates: SessionUpdate[]; truncated: boolean }
interface Group { start: number; end: number }
class ReplayBudgetExceeded extends Error {}

function entryMessage(entry: Entry): Message | undefined {
  if (entry.type === 'message') return decodeMessage(entry.message);
  if (entry.type === 'custom_message') return decodeMessage({ role: 'custom', content: entry.content, display: entry.display });
  // Compaction/context edits affect model context, not original displayed history.
  return undefined;
}

/** Validate all display messages before selecting a window. Cross-turn tool
 * links merge groups so selecting a user boundary never leaves orphan results. */
function turnGroups(branch: Entry[]): Group[] {
  const starts = [0];
  const ends: number[] = [0];
  const calls = new Map<string, number>();
  let turn = 0;
  for (let i = 0; i < branch.length; i++) {
    const message = entryMessage(branch[i]!);
    if (!message) continue;
    if (message.role === 'user' && i > starts[turn]!) { starts.push(i); ends.push(++turn); }
    if (Array.isArray(message.content)) for (const block of message.content) if (block.type === 'toolCall') {
      if (calls.has(block.id)) throw new Error('Overlapping historical tool call id');
      calls.set(block.id, turn);
    }
    if (message.role === 'toolResult') {
      const owner = message.toolCallId ? calls.get(message.toolCallId) : undefined;
      if (owner === undefined) throw new Error('Historical tool result has no preceding call');
      ends[owner] = Math.max(ends[owner]!, turn);
      calls.delete(message.toolCallId!);
    }
  }
  const groups: Group[] = [];
  for (let start = 0; start < starts.length;) {
    let end = ends[start]!;
    for (let i = start + 1; i <= end; i++) end = Math.max(end, ends[i]!);
    groups.push({ start: starts[start]!, end: starts[end + 1] ?? branch.length });
    start = end + 1;
  }
  return groups;
}

function entryIdentity(history: History, entry: Entry, aliases: ReadonlyMap<string, string>): string {
  return aliases.get(entry.id) ?? `${history.header.id}/entry/${entry.id}`;
}

function projectGroup(history: History, branch: Entry[], group: Group, aliases: ReadonlyMap<string, string>, budget: number, compact = false): HistoryProjection & { bytes: number } {
  const updates: SessionUpdate[] = [];
  let bytes = 0;
  const transcript = new Transcript(history.header.cwd, update => {
    const size = notificationBytes(history.header.id, update);
    if (bytes + size > budget) throw new ReplayBudgetExceeded();
    bytes += size; updates.push(update);
  }, undefined, history.header.id, { compact });
  for (let i = group.start; i < group.end; i++) {
    const entry = branch[i]!;
    const message = entryMessage(entry);
    if (message) transcript.replay(message, entryIdentity(history, entry, aliases));
  }
  transcript.finishTools();
  return { updates, bytes, truncated: transcript.replayTruncated };
}

/** Last-resort display for a pathological single turn (e.g. >4,096 tools).
 * Keep its newest user anchor and final visible reply; omit tool activity as a
 * unit rather than inventing calls or replaying unpaired results. */
function minimalGroup(history: History, branch: Entry[], group: Group, aliases: ReadonlyMap<string, string>): SessionUpdate[] {
  let user: Entry | undefined;
  let reply: Entry | undefined;
  for (let i = group.start; i < group.end; i++) {
    const entry = branch[i]!;
    const message = entryMessage(entry);
    if (message?.role === 'user') { user = entry; reply = undefined; }
    else if (message?.role === 'assistant' || message?.role === 'custom' && message.display) reply = entry;
  }
  const updates: SessionUpdate[] = [];
  for (const entry of [user, reply]) if (entry) {
    const message = entryMessage(entry)!;
    const blocks = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content ?? [];
    // Preserve original block indexes/aliases. Tool calls and results are omitted
    // together; no historical action, filesystem read or callback is invoked.
    for (let i = 0, retained = 0; i < blocks.length && retained < 16; i++) {
      const block = blocks[i]!;
      if (block.type !== 'text' && block.type !== 'thinking') continue;
      const value = block.type === 'text' ? block.text : block.thinking;
      let end = Math.min(value.length, 4096);
      if (end < value.length && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff) end--;
      updates.push({ sessionUpdate: message.role === 'user' ? 'user_message_chunk' : block.type === 'thinking' ? 'agent_thought_chunk' : 'agent_message_chunk',
        messageId: `${entryIdentity(history, entry, aliases)}/block/${i}`,
        content: { type: 'text', text: value.slice(0, end) + (end < value.length ? '\n[History display truncated]' : '') } });
      retained++;
    }
    if (message.role === 'user' && !updates.some(u => u.sessionUpdate === 'user_message_chunk')) updates.push({
      sessionUpdate: 'user_message_chunk', messageId: `${entryIdentity(history, entry, aliases)}/block/0`,
      content: { type: 'text', text: '[User content omitted from this bounded history display.]' },
    });
  }
  return updates;
}

/** Newest contiguous complete groups, under the existing 8 MiB wire budget.
 * Selection is presentation-only: Pi still opens the complete original file. */
export function projectHistoryWindow(history: History, aliases: ReadonlyMap<string, string> = new Map()): HistoryProjection {
  const branch = activeBranch(history.entries, history.leafId);
  const groups = turnGroups(branch);
  const notice: SessionUpdate = { sessionUpdate: 'agent_message_chunk', messageId: `${history.header.id}/history-omission/${history.leafId ?? 'empty'}`,
    content: { type: 'text', text: '[Some display history was omitted to fit the bounded restore window. Pi retains the complete conversation for continuation.]' },
    _meta: { 'com.airterm/pi-acp': { historyTruncated: true } } };
  const selected: SessionUpdate[][] = [];
  let bytes = notificationBytes(history.header.id, notice);
  let truncated = false;
  for (let i = groups.length - 1; i >= 0; i--) {
    let projected;
    try { projected = projectGroup(history, branch, groups[i]!, aliases, limits.replayBytes - bytes); }
    catch (error) {
      if (!(error instanceof ReplayBudgetExceeded || error instanceof TranscriptLimitError)) throw error;
      truncated = true;
      if (selected.length) break; // Keep a contiguous suffix, never skip a middle turn.
      try { projected = projectGroup(history, branch, groups[i]!, aliases, limits.replayBytes - bytes, true); }
      catch (compactError) {
        if (!(compactError instanceof ReplayBudgetExceeded || compactError instanceof TranscriptLimitError)) throw compactError;
        const updates = minimalGroup(history, branch, groups[i]!, aliases);
        projected = { updates, bytes: updates.reduce((sum, update) => sum + notificationBytes(history.header.id, update), 0), truncated: true };
      }
      selected.push(projected.updates); bytes += projected.bytes;
      break; // The oversized newest group is the complete retained window.
    }
    selected.push(projected.updates); bytes += projected.bytes;
    truncated ||= projected.truncated;
  }
  const updates = selected.reverse().flat();
  if (truncated) updates.unshift(notice);
  if (updates.reduce((sum, update) => sum + notificationBytes(history.header.id, update), 0) > limits.replayBytes) {
    throw new Error('History identity metadata exceeds replay budget');
  }
  return { updates, truncated };
}

export function projectHistory(history: History, aliases: ReadonlyMap<string, string> = new Map()): SessionUpdate[] {
  return projectHistoryWindow(history, aliases).updates;
}

import { z } from 'zod';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { limits } from '../limits.js';
import { decodeMessage, Transcript } from '../transcript/messages.js';
import { RecordReader } from '../pi/records.js';
import { openRegular } from './files.js';

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

export function projectHistory(history: History, aliases: ReadonlyMap<string, string> = new Map()): SessionUpdate[] {
  const updates: SessionUpdate[] = [];
  let bytes = 0;
  const transcript = new Transcript(history.header.cwd, update => {
    bytes += Buffer.byteLength(JSON.stringify(update));
    if (bytes > limits.replayBytes) throw new Error('Session exceeds history replay limit');
    updates.push(update);
  });
  for (const entry of activeBranch(history.entries, history.leafId)) {
    const id = aliases.get(entry.id) ?? `${history.header.id}/entry/${entry.id}`;
    if (entry.type === 'message') transcript.replay(decodeMessage(entry.message), id);
    else if (entry.type === 'custom_message') transcript.replay(decodeMessage({
      role: 'custom', content: entry.content, display: entry.display,
    }), id);
    // Compaction/context edits change model context, not the original transcript.
    // Metadata is emitted separately; historical entries never trigger live effects.
  }
  transcript.finishTools();
  return updates;
}

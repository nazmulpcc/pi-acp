import { z } from 'zod';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { limits } from '../limits.js';
import { decodeMessage, Transcript } from '../transcript/messages.js';

const entrySchema = z.looseObject({ type: z.string(), id: z.string().max(1024), parentId: z.string().max(1024).nullable(), timestamp: z.string() });
const headerSchema = z.looseObject({ type: z.literal('session'), version: z.literal(3), id: z.string().max(1024), cwd: z.string(), timestamp: z.string() });
export type Entry = z.infer<typeof entrySchema>;
export type Header = z.infer<typeof headerSchema>;
export interface History { header: Header; entries: Entry[]; leafId: string | null }

export async function readHistory(path: string): Promise<History> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limits.historyFileBytes) throw new Error('Session file is not regular or exceeds history limit');
    const entries: Entry[] = [];
    let header: Header | undefined;
    let bytes = 0;
    let pending = Buffer.alloc(0);
    const block = Buffer.alloc(64 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(block, 0, block.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > limits.historyFileBytes) throw new Error('Session grew beyond history limit');
      pending = Buffer.concat([pending, block.subarray(0, bytesRead)]);
      let start = 0;
      for (let i = 0; i < pending.length; i++) if (pending[i] === 10) {
        const line = pending.subarray(start, i);
        if (line.length > limits.recordBytes) throw new Error('Oversized session entry');
        if (line.length) {
          const value: unknown = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(line));
          if (!header) header = headerSchema.parse(value);
          else entries.push(entrySchema.parse(value));
          if (entries.length > limits.historyEntries) throw new Error('Too many session entries');
        }
        start = i + 1;
      }
      pending = Buffer.from(pending.subarray(start));
      if (pending.length > limits.recordBytes) throw new Error('Oversized session entry');
    }
    if (pending.length) throw new Error('Incomplete session file; retry after Pi finishes writing');
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

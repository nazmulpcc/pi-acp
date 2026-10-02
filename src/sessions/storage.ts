import { constants } from 'node:fs';
import { mkdir, open, opendir, rename, realpath, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { limits } from '../limits.js';
import type { FinalizedMessage } from '../transcript/messages.js';
import { decodeMessage } from '../transcript/messages.js';
import { readHistory, type Entry, type Header } from './history.js';
import { openRegular } from './files.js';
import { RecordReader } from '../pi/records.js';
import { sessionTitle } from './name.js';

export function expandPath(path: string, cwd = process.cwd()): string {
  return resolve(cwd, path === '~' ? homedir() : path.startsWith('~/') || path.startsWith('~\\') ? join(homedir(), path.slice(2)) : path);
}
export function agentDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_DIR ? expandPath(env.PI_CODING_AGENT_DIR) : join(homedir(), '.pi', 'agent');
}
export function defaultSessionDirectory(cwd: string, agentDir: string): string {
  return join(agentDir, 'sessions', `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
}
export async function smallJson(path: string, max = limits.previewBytes): Promise<unknown> {
  const handle = await openRegular(path, max);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > max) throw new Error('Oversized or nonregular configuration');
    const bytes = Buffer.alloc(max + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > max) throw new Error('Oversized configuration');
    return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, '')) as unknown;
  } finally { await handle.close(); }
}
async function setting(path: string): Promise<string | undefined> {
  try {
    const value = await smallJson(path);
    if (!value || typeof value !== 'object') throw new Error('Invalid Pi settings');
    const dir = (value as Record<string, unknown>).sessionDir;
    if (dir !== undefined && typeof dir !== 'string') throw new Error('Invalid Pi sessionDir setting');
    return dir as string | undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export interface StoredSession { id: string; path: string; cwd: string; updatedAt: string; title?: string }
const storedSchema = z.object({ id: z.string().max(1024), path: z.string(), cwd: z.string(), updatedAt: z.string(), title: z.string().optional() });
const aliasSchema = z.object({ version: z.literal(1), session: storedSchema, aliases: z.record(z.string(), z.string()) });

/** Metadata and aliases only. Each session has a separate atomic file and lease. */
export class Storage {
  readonly root: string;
  constructor(readonly agentDir = agentDirectory(), readonly sessionDir?: string,
              private readonly env: NodeJS.ProcessEnv = process.env) { this.root = join(agentDir, 'pi-acp'); }
  private key(id: string): string { return createHash('sha256').update(id).digest('hex'); }
  private metadataPath(id: string): string { return join(this.root, `${this.key(id)}.json`); }

  async directory(cwd: string): Promise<string> {
    const configured = this.sessionDir ?? this.env.PI_CODING_AGENT_SESSION_DIR ??
      await setting(join(cwd, '.pi', 'settings.json')) ?? await setting(join(this.agentDir, 'settings.json'));
    return configured ? expandPath(configured, cwd) : defaultSessionDirectory(cwd, this.agentDir);
  }

  async acquire(id: string, onCompromised: (error: Error) => void): Promise<() => Promise<void>> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    // The lock target has no conversation data; no external Pi runtime is altered.
    const path = join(this.root, `${this.key(id)}.lease`);
    const handle = await open(path, constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    await handle.close();
    try {
      return await lockfile.lock(path, { realpath: false, stale: 10_000, update: 2_000, retries: 0, onCompromised });
    } catch { throw new Error('Session is already owned by another adapter; close it there before reopening'); }
  }

  async aliases(id: string): Promise<Map<string, string>> {
    try {
      const data = aliasSchema.parse(await smallJson(this.metadataPath(id), limits.replayBytes));
      if (data.session.id !== id) throw new Error('Session identity metadata mismatch');
      return new Map(Object.entries(data.aliases));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
      throw new Error('Invalid adapter identity metadata');
    }
  }
  async save(session: StoredSession, aliases: ReadonlyMap<string, string>): Promise<void> {
    const data = JSON.stringify({ version: 1, session, aliases: Object.fromEntries(aliases) });
    if (Buffer.byteLength(data) > limits.replayBytes || aliases.size > limits.historyEntries) throw new Error('Identity metadata exceeds limit');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = this.metadataPath(session.id);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(() => {}); }
  }

  async discover(cwd?: string): Promise<StoredSession[]> {
    const started = Date.now();
    const candidates = new Set<string>();
    let count = 0;
    const deadline = () => {
      if (Date.now() - started > limits.discoveryMs) throw new Error('Session discovery limit exceeded; specify a workspace or --session-dir');
    };
    const guard = () => {
      if (++count > limits.discoveryFiles || Date.now() - started > limits.discoveryMs) throw new Error('Session discovery limit exceeded; specify a workspace or --session-dir');
    };
    const scan = async (directory: string, depth: number): Promise<void> => {
      let files;
      try { files = await opendir(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      for await (const file of files) {
        guard();
        const path = join(directory, file.name);
        if (file.isFile() && file.name.endsWith('.jsonl')) candidates.add(path);
        else if (depth && file.isDirectory()) await scan(path, depth - 1);
      }
    };
    if (cwd) await scan(await this.directory(cwd), 0);
    else {
      await scan(join(this.agentDir, 'sessions'), 1);
      const configured = this.sessionDir ?? this.env.PI_CODING_AGENT_SESSION_DIR ?? await setting(join(this.agentDir, 'settings.json'));
      if (configured) await scan(expandPath(configured), 0);
    }
    // Include custom directories previously opened through this adapter.
    try {
      for await (const entry of await opendir(this.root)) {
        const file = entry.name;
        guard();
        if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
        const saved = aliasSchema.parse(await smallJson(join(this.root, file), limits.replayBytes));
        if (!cwd || saved.session.cwd === cwd) candidates.add(saved.session.path);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const found = new Map<string, StoredSession>();
    for (const path of candidates) {
      guard();
      try {
        const session = await this.header(path, deadline);
        if (cwd && await realpath(session.cwd) !== await realpath(cwd)) continue;
        const previous = found.get(session.id);
        if (previous && previous.path !== session.path) throw new Error('Ambiguous duplicate Pi session id');
        found.set(session.id, session);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        // Invalid headers in Pi's storage are not compatible sessions.
        if (error instanceof z.ZodError || error instanceof SyntaxError) continue;
        throw error;
      }
    }
    return [...found.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }

  async find(id: string, cwd: string): Promise<StoredSession> {
    const sessions = await this.discover(cwd);
    const found = sessions.find(s => s.id === id);
    if (!found) throw new Error('Pi session was not found in its original workspace');
    return found;
  }

  private async header(path: string, deadline: () => void): Promise<StoredSession> {
    const handle = await openRegular(path, limits.historyFileBytes);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error('Session candidate is not a regular file');
      const bytes = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const end = bytes.subarray(0, bytesRead).indexOf(10);
      if (end < 0) throw new SyntaxError('Missing bounded session header');
      const header = z.object({ type: z.literal('session'), version: z.literal(3), id: z.string().max(1024), cwd: z.string(), timestamp: z.string() }).parse(JSON.parse(bytes.subarray(0, end).toString('utf8')));
      if (!isAbsolute(header.cwd)) throw new SyntaxError('Session cwd must be absolute');
      // A name can precede arbitrarily many messages. Stream the bounded file,
      // retaining only the latest metadata, independent of branch and aliases.
      let title: string | undefined;
      let entries = 0;
      const reader = new RecordReader(value => {
        if (++entries > limits.historyEntries) throw new Error('Session discovery entry limit exceeded');
        if (value && typeof value === 'object' && (value as Record<string, unknown>).type === 'session_info') {
          title = sessionTitle((value as Record<string, unknown>).name);
        }
      });
      let position = end + 1;
      while (position < info.size) {
        deadline();
        const chunk = await handle.read(bytes, 0, Math.min(bytes.length, info.size - position), position);
        if (!chunk.bytesRead) break;
        reader.push(bytes.subarray(0, chunk.bytesRead));
        position += chunk.bytesRead;
      }
      // An active writer can have a partial final record; only complete entries
      // participate in listing. Loading still requires complete valid history.
      return { id: header.id, cwd: header.cwd, path: resolve(path), updatedAt: info.mtime.toISOString(), ...(title ? { title } : {}) };
    } finally { await handle.close(); }
  }
}

/** Verify append provenance by occurrence, role and tool links, never text hashes. */
export function reconcileAliases(entries: Entry[], finalized: FinalizedMessage[], aliases: Map<string, string>, previousLeaf?: string | null): boolean {
  if (previousLeaf !== undefined && entries[0]?.parentId !== previousLeaf && entries.length) return false;
  for (let i = 1; i < entries.length; i++) if (entries[i]!.parentId !== entries[i - 1]!.id) return false;
  const persisted = entries.filter(e => e.type === 'message' || e.type === 'custom_message');
  if (persisted.length !== finalized.length) return false;
  for (let i = 0; i < persisted.length; i++) {
    const entry = persisted[i]!;
    const message = entry.type === 'message' ? decodeMessage(entry.message) : decodeMessage({ role: 'custom', content: entry.content, display: entry.display });
    const live = finalized[i]!.message;
    if (message.role !== live.role || message.toolCallId !== live.toolCallId) return false;
    const ids = (m: typeof message) => Array.isArray(m.content) ? m.content.filter(b => b.type === 'toolCall').map(b => b.id) : [];
    if (JSON.stringify(ids(message)) !== JSON.stringify(ids(live))) return false;
  }
  persisted.forEach((entry, i) => aliases.set(entry.id, finalized[i]!.id));
  return true;
}

export async function authoritativeHistory(path: string, header: Header, leafId: unknown) {
  const history = await readHistory(path);
  if (history.header.id !== header.id || history.header.cwd !== header.cwd) throw new Error('Pi session identity changed');
  if (leafId !== null && typeof leafId !== 'string') throw new Error('Invalid Pi history leaf');
  history.leafId = leafId;
  return history;
}

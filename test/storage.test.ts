import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage, reconcileAliases } from '../src/sessions/storage.js';
import { readHistory } from '../src/sessions/history.js';

test('custom discovery validates headers and metadata, and does not launch Pi', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-acp-storage-'));
  try {
    const cwd = join(root, 'work'); const sessions = join(root, 'sessions');
    await mkdir(cwd); await mkdir(sessions);
    await writeFile(join(sessions, 'one.jsonl'), JSON.stringify({ type: 'session', version: 3, id: 'one', cwd, timestamp: '' }) + '\n');
    await writeFile(join(sessions, 'invalid.jsonl'), '{}\n');
    const storage = new Storage(join(root, 'agent'), sessions);
    const found = await storage.discover(cwd);
    assert.equal(found.length, 1); assert.equal(found[0]!.id, 'one');
    const aliases = new Map([['entry', 'live']]);
    await storage.save(found[0]!, aliases);
    assert.deepEqual(await storage.aliases('one'), aliases);
    const release = await storage.acquire('one', () => {});
    await assert.rejects(storage.acquire('one', () => {}), /already owned/);
    await release();
    await (await storage.acquire('one', () => {}))();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('incomplete history is rejected and aliases use structural occurrence, including identical messages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-acp-history-'));
  try {
    const path = join(root, 's.jsonl');
    await writeFile(path, '{"type":"session"}');
    await assert.rejects(readHistory(path), /Incomplete/);
    const message = { role: 'user' as const, content: 'same' };
    const aliases = new Map<string, string>();
    assert.equal(reconcileAliases([
      { type: 'message', id: 'a', parentId: null, timestamp: '', message },
      { type: 'message', id: 'b', parentId: 'a', timestamp: '', message },
    ], [{ message, id: 'first' }, { message, id: 'second' }], aliases), true);
    assert.deepEqual([...aliases], [['a', 'first'], ['b', 'second']]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

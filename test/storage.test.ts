import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage, reconcileAliases, smallJson } from '../src/sessions/storage.js';
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

test('discovery retains old names beyond the tail, uses latest metadata and respects clears', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-acp-names-'));
  try {
    const cwd = join(root, 'work'); const directory = join(root, 'sessions');
    await mkdir(cwd); await mkdir(directory);
    const path = join(directory, 'named.jsonl');
    const record = (value: unknown) => JSON.stringify(value) + '\n';
    await writeFile(path, record({ type: 'session', version: 3, id: 'named', cwd, timestamp: '' }) +
      record({ type: 'session_info', name: 'Early title 🦊' }) + record({ type: 'message', message: { role: 'user', content: '🦊'.repeat(30_000) } }));
    const storage = new Storage(join(root, 'agent'), directory);
    assert.equal((await storage.discover(cwd))[0]!.title, 'Early title 🦊');
    await storage.save({ ...(await storage.discover(cwd))[0]!, title: 'Stale metadata' }, new Map());
    await appendFile(path, record({ type: 'session_info', name: 'Latest title' }));
    assert.equal((await storage.discover(cwd))[0]!.title, 'Latest title');
    await appendFile(path, record({ type: 'session_info', name: '' }));
    assert.equal((await storage.discover(cwd))[0]!.title, undefined);
    await appendFile(path, record({ type: 'session_info', name: 'a'.repeat(255) + '🦊' }));
    assert.equal((await storage.discover(cwd))[0]!.title, 'a'.repeat(255));
    await appendFile(path, record({ type: 'session_info' }));
    assert.equal((await storage.discover(cwd))[0]!.title, undefined);
    await appendFile(path, '{"type":"session_info","name":"Uncommitted');
    assert.equal((await storage.discover(cwd))[0]!.title, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('configuration and history refuse special files without blocking', { skip: process.platform === 'win32', timeout: 2000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-acp-file-types-'));
  try {
    const fifo = join(root, 'fifo'); execFileSync('mkfifo', [fifo]);
    await assert.rejects(smallJson(fifo), /nonregular/);
    await assert.rejects(readHistory(fifo), /nonregular/);
    const regular = join(root, 'settings.json'); await writeFile(regular, '{}');
    const link = join(root, 'link'); await symlink(regular, link);
    await assert.rejects(smallJson(link), /nonregular/);
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

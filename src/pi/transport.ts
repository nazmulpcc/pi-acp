import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import spawn from 'cross-spawn';
import { limits } from '../limits.js';
import { RecordReader, record, type PiRecord } from './records.js';

export interface LaunchOptions {
  executable: string;
  cwd: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}
interface Pending {
  command: string;
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** Owns only one child generation. It never serializes incoming event handling. */
export class PiTransport {
  readonly generation = randomUUID();
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(event: PiRecord) => void>();
  private readonly closeListeners = new Set<(error: Error) => void>();
  private error: Error | undefined;
  private writes: Promise<void> = Promise.resolve();
  private writeCount = 0;
  private writeBytes = 0;
  private closing: Promise<void> | undefined;
  private exited = false;
  private readonly exitPromise: Promise<void>;

  constructor(options: LaunchOptions) {
    this.child = spawn(options.executable, options.args ?? ['--mode', 'rpc'], {
      cwd: options.cwd, env: options.env ?? process.env, stdio: 'pipe', windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    this.exitPromise = new Promise(resolve => this.child.once('close', () => { this.exited = true; resolve(); }));
    const reader = new RecordReader(value => this.ingest(record(value)));
    this.child.stdout.on('data', (chunk: Buffer) => {
      if (this.error) return;
      try { reader.push(chunk); } catch { this.fail(new Error('Invalid or oversized Pi protocol record')); }
    });
    this.child.stdout.once('end', () => {
      try { reader.end(); } catch { this.fail(new Error('Truncated Pi protocol stream')); }
      this.fail(new Error('Pi protocol stream closed'));
    });
    // Always drain diagnostics, but do not retain or forward potentially secret payloads.
    this.child.stderr.on('data', () => {});
    this.child.once('error', () => this.fail(new Error('Cannot launch Pi executable')));
    this.child.stdin.on('error', () => this.fail(new Error('Pi command pipe failed')));
    this.child.once('close', (code, signal) => this.fail(new Error(`Pi exited (code=${code}, signal=${signal})`)));
  }

  onEvent(listener: (event: PiRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onClose(listener: (error: Error) => void): () => void {
    if (this.error) listener(this.error);
    else this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
  get alive(): boolean { return !this.error; }

  request(command: string, data: Record<string, unknown> = {}, timeoutMs: number | null = limits.controlMs): Promise<unknown> {
    if (this.error) return Promise.reject(this.error);
    if (this.pending.size >= limits.pendingRequests) return Promise.reject(new Error('Too many pending Pi requests'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === null ? undefined : setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi ${command} response timed out`));
      }, timeoutMs);
      this.pending.set(id, { command, resolve, reject, timer });
      void this.send({ ...data, type: command, id }).catch(error => this.fail(error as Error));
    });
  }

  send(value: Record<string, unknown>): Promise<void> {
    if (this.error) return Promise.reject(this.error);
    const line = JSON.stringify(value) + '\n';
    const bytes = Buffer.byteLength(line);
    if (bytes > limits.recordBytes) return Promise.reject(new Error('Pi command exceeds byte limit'));
    if (this.writeCount >= limits.pendingRequests || this.writeBytes + bytes > limits.recordBytes) return Promise.reject(new Error('Pi write queue exceeds limit'));
    this.writeCount++; this.writeBytes += bytes;
    const next = this.writes.then(() => new Promise<void>((resolve, reject) => {
      if (this.error) return reject(this.error);
      this.child.stdin.write(line, error => error ? reject(new Error('Pi command write failed')) : resolve());
    })).finally(() => { this.writeCount--; this.writeBytes -= bytes; });
    this.writes = next.catch(() => {});
    return next;
  }

  close(): Promise<void> {
    return this.closing ??= this.shutdown();
  }

  private async shutdown(): Promise<void> {
    this.fail(new Error('Pi transport closed'));
    this.child.stdin.end();
    for (const signal of [undefined, 'SIGTERM', 'SIGKILL'] as const) {
      if (this.exited) break;
      if (signal) this.child.kill(signal);
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, limits.shutdownMs);
        void this.exitPromise.then(() => { clearTimeout(timer); resolve(); });
      });
    }
    this.listeners.clear();
    this.closeListeners.clear();
  }

  private ingest(event: PiRecord): void {
    if (event.type === 'response') {
      if (typeof event.id !== 'string') throw new Error('Pi response missing correlation id');
      const pending = this.pending.get(event.id);
      if (!pending) return; // Retired response, never a session event.
      if (event.command !== pending.command || typeof event.success !== 'boolean') {
        throw new Error('Pi response command or shape mismatch');
      }
      this.pending.delete(event.id);
      clearTimeout(pending.timer);
      if (event.success) pending.resolve(event.data);
      else pending.reject(new Error(`Pi ${pending.command} command failed`));
      return;
    }
    for (const listener of [...this.listeners]) listener(event);
  }

  private fail(error: Error): void {
    if (this.error) return;
    this.error = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const listener of [...this.closeListeners]) listener(error);
    this.closeListeners.clear();
    // A broken protocol must not leave a writable orphan running.
    queueMicrotask(() => { void this.close(); });
  }
}

export async function verifyPi(options: LaunchOptions): Promise<void> {
  options.signal?.throwIfAborted();
  const child = spawn(options.executable, ['--version'], {
    cwd: options.cwd, env: options.env ?? process.env, stdio: 'pipe', windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    const abort = () => { child.kill('SIGKILL'); reject(new Error('Pi version check cancelled')); };
    options.signal?.addEventListener('abort', abort, { once: true });
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Pi version check timed out')); }, limits.controlMs);
    child.stdout?.on('data', (data: Buffer) => {
      output += data.toString('utf8');
      if (output.length > 4096) { child.kill('SIGKILL'); reject(new Error('Invalid Pi version output')); }
    });
    child.stderr?.on('data', () => {});
    child.once('error', () => { clearTimeout(timer); reject(new Error('Pi not found; install Pi or set --pi')); });
    child.once('close', code => {
      options.signal?.removeEventListener('abort', abort);
      clearTimeout(timer);
      if (code !== 0) reject(new Error('Pi executable check failed; verify the installed executable or set --pi'));
      else resolve();
    });
  });
}

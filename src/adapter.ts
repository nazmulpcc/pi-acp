import { agent, methods, PROTOCOL_VERSION, RequestError, type AgentContext, type AgentConnection, type ClientCapabilities,
  type LoadSessionRequest, type NewSessionRequest, type ResumeSessionRequest } from '@agentclientprotocol/sdk';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { ZodError } from 'zod';
import { limits } from './limits.js';
import { Session } from './session.js';
import { Storage, type StoredSession } from './sessions/storage.js';
import { readHistory, projectHistoryWindow } from './sessions/history.js';
import { verifyPi, type LaunchOptions } from './pi/transport.js';
import { promptToPi } from './prompt.js';

export interface AdapterOptions {
  executable: string;
  storage: Storage;
  trust?: 'approve' | 'no-approve';
  env?: NodeJS.ProcessEnv;
  diagnostic?: (message: string) => void;
  // Injected boundaries for internal tests, never exposed through the CLI.
  launch?: (options: LaunchOptions) => LaunchOptions;
  verify?: (options: LaunchOptions) => Promise<void>;
}
interface Listing { sessions: StoredSession[]; index: number; cwd: string | undefined; expires: number }

export class Adapter {
  readonly app = agent({ name: 'airterm-pi-acp' });
  private readonly sessions = new Map<string, Session>();
  private readonly opening = new Set<string>();
  private readonly starting = new Set<Session>();
  private readonly openTasks = new Set<Promise<Session>>();
  private readonly shutdownSignal = new AbortController();
  private readonly listings = new Map<string, Listing>();
  private initialized = false;
  private capabilities: ClientCapabilities = {};
  private connection: AgentConnection | undefined;
  private outstandingForms = 0;
  private requests = 0;
  private closing: Promise<void> | undefined;
  private readonly diagnostic: (message: string) => void;

  constructor(private readonly options: AdapterOptions) {
    this.diagnostic = options.diagnostic ?? (() => {});
    this.app.onConnect(connection => {
      this.connection = connection;
      void connection.closed.then(() => this.close());
    });
    this.app.onRequest(methods.agent.initialize, context => {
      if (this.initialized) throw RequestError.invalidParams(undefined, 'ACP connection already initialized');
      this.initialized = true; this.capabilities = context.params.clientCapabilities ?? {};
      return { protocolVersion: PROTOCOL_VERSION, agentInfo: { name: 'airterm-pi-acp', version: '0.1.0', title: 'Pi ACP' },
        authMethods: [], agentCapabilities: { loadSession: true,
          promptCapabilities: { image: true, embeddedContext: true, audio: false },
          mcpCapabilities: { http: false, sse: false }, sessionCapabilities: { list: {}, resume: {}, close: {} } } };
    });
    this.app.onRequest(methods.agent.authenticate, () => {
      throw RequestError.methodNotFound('authenticate; configure provider credentials in Pi before using this adapter');
    });
    this.app.onRequest(methods.agent.session.new, context => this.guard(async () => {
      const session = await this.open(context.params, context.client);
      return { sessionId: session.id, configOptions: session.configuration };
    }));
    this.app.onRequest(methods.agent.session.load, context => this.guard(async () => {
      const session = await this.open(context.params, context.client, true);
      return { configOptions: session.configuration, ...(session.historyTruncated ? { _meta: { 'com.airterm/pi-acp': { historyTruncated: true } } } : {}) };
    }));
    this.app.onRequest(methods.agent.session.resume, context => this.guard(async () => {
      const session = await this.open(context.params, context.client, false);
      return { configOptions: session.configuration };
    }));
    this.app.onRequest(methods.agent.session.close, context => this.guard(async () => {
      const session = this.get(context.params.sessionId);
      await session.close(); this.sessions.delete(session.id); return {};
    }));
    this.app.onRequest(methods.agent.session.prompt, context => this.guard(async () => {
      const session = this.get(context.params.sessionId);
      const prompt = promptToPi(context.params.prompt);
      const cancel = () => { void session.cancel(); };
      context.signal.addEventListener('abort', cancel, { once: true });
      try {
        const result = session.prompt(prompt.message, prompt.images);
        if (context.signal.aborted) cancel();
        return { stopReason: await result };
      } finally { context.signal.removeEventListener('abort', cancel); }
    }));
    this.app.onNotification(methods.agent.session.cancel, context => {
      const session = this.sessions.get(context.params.sessionId);
      if (session) void session.cancel();
    });
    this.app.onRequest(methods.agent.session.setConfigOption, context => this.guard(async () => ({
      configOptions: await this.get(context.params.sessionId).configure(context.params.configId, context.params.value),
    })));
    this.app.onRequest(methods.agent.session.list, context => this.guard(async () => {
      const cwd = context.params.cwd ? await this.workspace(context.params.cwd) : undefined;
      for (const [key, listing] of this.listings) if (listing.expires < Date.now()) this.listings.delete(key);
      let listing: Listing;
      if (context.params.cursor) {
        const found = this.listings.get(context.params.cursor);
        if (!found || found.cwd !== cwd) throw new Error('Invalid or expired session-list cursor');
        listing = found; this.listings.delete(context.params.cursor);
      } else {
        const sessions = await options.storage.discover(cwd);
        for (const session of this.sessions.values()) {
          const info = session.info;
          if (info && (!cwd || info.cwd === cwd)) {
            const index = sessions.findIndex(s => s.id === info.id);
            if (index < 0) sessions.push(info); else sessions[index] = info;
          }
        }
        sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
        listing = { sessions, index: 0, cwd, expires: Date.now() + 60_000 };
      }
      const page = listing.sessions.slice(listing.index, listing.index + 100);
      listing.index += page.length;
      let nextCursor: string | undefined;
      if (listing.index < listing.sessions.length) {
        if (this.listings.size >= 8) throw new Error('Too many active session listings');
        nextCursor = randomUUID(); this.listings.set(nextCursor, listing);
      }
      return { sessions: page.map(s => ({ sessionId: s.id, cwd: s.cwd, updatedAt: s.updatedAt, ...(s.title ? { title: s.title } : {}) })),
        ...(nextCursor ? { nextCursor } : {}) };
    }));
  }

  close(): Promise<void> { return this.closing ??= this.shutdown(); }
  private async shutdown(): Promise<void> {
    this.shutdownSignal.abort();
    await Promise.allSettled([...this.sessions.values(), ...this.starting].map(session => session.close()));
    await Promise.allSettled(this.openTasks);
    this.sessions.clear(); this.listings.clear();
  }

  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.initialized) throw RequestError.invalidParams(undefined, 'Initialize ACP before using sessions');
    if (this.closing) throw RequestError.internalError(undefined, 'Adapter is closing');
    if (this.requests >= limits.pendingRequests) throw RequestError.internalError(undefined, 'Too many pending ACP requests');
    this.requests++;
    try { return await operation(); }
    catch (error) {
      if (error instanceof RequestError) throw error;
      // Never serialize untrusted payloads, subprocess stderr, or local stack traces.
      const message = error instanceof Error && !(error instanceof SyntaxError) && !(error instanceof ZodError) ? error.message.slice(0, 256) : 'Adapter operation failed';
      throw RequestError.internalError(undefined, message);
    } finally { this.requests--; }
  }
  private get(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Unknown ACP session');
    return session;
  }
  private async workspace(path: string): Promise<string> {
    if (!isAbsolute(path)) throw new Error('Workspace must be an absolute directory');
    const cwd = await realpath(path);
    if (!(await stat(cwd)).isDirectory()) throw new Error('Workspace is not a directory');
    return cwd;
  }

  private open(params: NewSessionRequest | LoadSessionRequest | ResumeSessionRequest, client: AgentContext, replay = false): Promise<Session> {
    const task = this.performOpen(params, client, replay);
    this.openTasks.add(task);
    return task.finally(() => this.openTasks.delete(task));
  }
  private ensureOpen(): void { if (this.shutdownSignal.signal.aborted) throw new Error('Adapter is closing'); }
  private async performOpen(params: NewSessionRequest | LoadSessionRequest | ResumeSessionRequest, client: AgentContext, replay: boolean): Promise<Session> {
    if (params.mcpServers?.length) throw new Error('ACP-provided MCP servers are unsupported; configure MCP in Pi separately');
    if (params.additionalDirectories?.length) throw new Error('Additional workspace roots are unsupported');
    const requestedCwd = await this.workspace(params.cwd);
    this.ensureOpen();
    const id = 'sessionId' in params ? params.sessionId : randomUUID();
    if (this.opening.has(id)) throw new Error('Session is already opening');
    const existing = this.sessions.get(id);
    if (existing) {
      if (existing.busy) throw new Error('Cannot reopen an active session');
      await existing.close(); this.sessions.delete(id);
      this.ensureOpen();
    }
    if (this.sessions.size + this.opening.size >= limits.sessions) throw new Error('Open session limit reached; close a session first');
    this.opening.add(id);
    let session: Session | undefined;
    let release: (() => Promise<void>) | undefined;
    let released = false;
    const releaseOnce = async () => { if (!released && release) { released = true; await release(); } };
    try {
      const stored = 'sessionId' in params ? await this.options.storage.find(id, requestedCwd) : undefined;
      const cwd = stored ? stored.cwd : requestedCwd;
      if (await this.workspace(cwd) !== requestedCwd) throw new Error('Requested workspace differs from original Pi workspace');
      release = await this.options.storage.acquire(id, () => { void session?.close(); });
      const aliases = await this.options.storage.aliases(id);
      const history = stored ? await readHistory(stored.path) : undefined;
      if (history && history.header.id !== id) throw new Error('Pi session header identity mismatch');
      const projection = replay && history ? projectHistoryWindow(history, aliases) : { updates: [], truncated: false };
      const directory = await this.options.storage.directory(cwd);
      this.ensureOpen();
      const launch: LaunchOptions = { executable: this.options.executable, cwd, env: this.options.env ?? process.env,
        signal: this.shutdownSignal.signal,
        args: ['--mode', 'rpc', '--session-dir', directory, ...(stored ? ['--session', stored.path] : ['--session-id', id]),
          ...(this.options.trust ? [`--${this.options.trust}`] : [])] };
      await (this.options.verify ?? verifyPi)(launch);
      this.ensureOpen();
      session = new Session({ id, cwd, storage: this.options.storage, aliases, previousEntry: history?.entries.at(-1)?.id ?? null,
        ...(stored ? { updatedAt: stored.updatedAt } : {}),
        historyTruncated: projection.truncated,
        launch: this.options.launch ? this.options.launch(launch) : launch,
        elicitation: this.capabilities.elicitation?.form != null,
        client: { createElicitation: async (request, signal) => {
          if (this.outstandingForms >= 64) throw new Error('Unanswered ACP interaction limit exceeded');
          this.outstandingForms++;
          try { return await client.request('elicitation/create', request, signal ? { cancellationSignal: signal } : {}); }
          finally { this.outstandingForms--; }
        } },
        send: update => client.notify('session/update', { sessionId: id, update }), diagnostic: this.diagnostic, release: releaseOnce,
        outputFailure: () => { this.connection?.close(); void this.close(); },
      });
      this.starting.add(session);
      await session.start();
      this.ensureOpen();
      // Validate and reserve the entire replay before producing any transcript output.
      for (const update of projection.updates) { this.ensureOpen(); session.output.push(update); await session.output.flush(); }
      this.sessions.set(id, session);
      return session;
    } catch (error) {
      if (session) await session.close(); else await releaseOnce();
      throw error;
    } finally { this.opening.delete(id); if (session) this.starting.delete(session); }
  }
}

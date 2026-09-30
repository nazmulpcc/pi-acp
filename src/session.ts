import { z } from 'zod';
import type { SessionConfigOption, SessionUpdate, StopReason } from '@agentclientprotocol/sdk';
import { limits } from './limits.js';
import { Interactions, type InteractionClient } from './interactions.js';
import { OutputQueue } from './output.js';
import { object, type PiRecord } from './pi/records.js';
import { PiTransport, type LaunchOptions } from './pi/transport.js';
import { Transcript } from './transcript/messages.js';
import { Storage, reconcileAliases, type StoredSession } from './sessions/storage.js';
import type { Entry } from './sessions/history.js';

const stateSchema = z.looseObject({
  sessionId: z.string(), sessionFile: z.string().optional(), sessionName: z.string().optional(),
  isStreaming: z.boolean(), isCompacting: z.boolean(), pendingMessageCount: z.number().int().nonnegative(),
  thinkingLevel: z.string(), model: z.looseObject({ provider: z.string(), id: z.string() }).optional(),
});
interface Turn {
  resolve: (reason: StopReason) => void;
  reject: (error: Error) => void;
  cancelled: boolean;
  accepted: boolean;
  running: boolean;
  settled: boolean;
  finishing: boolean;
  lastStop?: string;
  error?: Error;
  preflight?: ReturnType<typeof setTimeout>;
  cancelTimer?: ReturnType<typeof setTimeout>;
}
export interface SessionOptions {
  id: string;
  cwd: string;
  launch: LaunchOptions;
  storage: Storage;
  aliases: Map<string, string>;
  previousEntry: string | null;
  updatedAt?: string;
  historyTruncated?: boolean;
  client: InteractionClient;
  elicitation: boolean;
  send: (update: SessionUpdate) => Promise<void>;
  diagnostic: (message: string) => void;
  release: () => Promise<void>;
  outputFailure?: () => void;
}

/** Owns session state, one child generation, and exactly one active prompt. */
export class Session {
  readonly id: string;
  readonly cwd: string;
  readonly transport: PiTransport;
  readonly output: OutputQueue;
  private readonly interactions: Interactions;
  private transcript: Transcript;
  private turn: Turn | undefined;
  private background = false;
  private backgroundGeneration = 0;
  private backgroundFlush: Promise<void> = Promise.resolve();
  private dead: Error | undefined;
  private closed: Promise<void> | undefined;
  private previousEntry: string | null;
  private state: z.infer<typeof stateSchema> | undefined;
  private config: SessionConfigOption[] = [];
  private configBusy = false;
  private updatedAt: string;

  constructor(private readonly options: SessionOptions) {
    this.id = options.id; this.cwd = options.cwd; this.previousEntry = options.previousEntry;
    this.updatedAt = options.updatedAt ?? new Date().toISOString();
    this.transport = new PiTransport(options.launch);
    this.output = new OutputQueue(options.send, error => { this.fail(error); options.outputFailure?.(); });
    this.transcript = new Transcript(this.cwd, update => this.output.push(update), undefined, this.id);
    this.interactions = new Interactions(this.id, options.client, options.elicitation,
      reply => this.transport.send(reply), () => this.touch(), options.diagnostic);
    this.transport.onEvent(event => {
      try { this.event(event); } catch (error) { this.fail(error as Error); }
    });
    this.transport.onClose(error => this.fail(error));
  }
  get healthy(): boolean { return !this.dead; }
  get historyTruncated(): boolean { return this.options.historyTruncated === true; }
  get configuration(): SessionConfigOption[] { return this.config; }
  get busy(): boolean { return !this.dead && (!!this.turn || this.background || this.configBusy); }
  get info(): StoredSession | undefined {
    if (!this.state?.sessionFile) return undefined;
    return { id: this.id, cwd: this.cwd, path: this.state.sessionFile, updatedAt: this.updatedAt,
      ...(this.state.sessionName ? { title: this.state.sessionName } : {}) };
  }

  async start(): Promise<SessionConfigOption[]> {
    this.state = this.decodeState(await this.transport.request('get_state', {}, limits.startupMs));
    const entries = object(await this.transport.request('get_entries', this.previousEntry ? { since: this.previousEntry } : {}));
    if (!Array.isArray(entries.entries)) throw new Error('Invalid Pi entries response');
    const last = entries.entries.at(-1) as Record<string, unknown> | undefined;
    if (last && typeof last.id === 'string') this.previousEntry = last.id;
    await this.refresh();
    await this.persist();
    await this.output.flush();
    return this.config;
  }

  prompt(message: string, images: { type: 'image'; data: string; mimeType: string }[]): Promise<StopReason> {
    if (this.dead) return Promise.reject(new Error('Session is unavailable; load or resume it explicitly'));
    if (this.busy) return Promise.reject(new Error('Session is busy; concurrent prompts are not supported'));
    this.transcript = new Transcript(this.cwd, update => this.output.push(update), undefined, this.id);
    return new Promise((resolve, reject) => {
      const turn: Turn = { resolve, reject, cancelled: false, accepted: false, running: false, settled: false, finishing: false };
      this.turn = turn;
      this.touch();
      // A command/extension can ask questions before returning its disposition.
      void this.transport.request('prompt', { message, ...(images.length ? { images } : {}) }, null).then(async data => {
        if (this.turn !== turn || this.dead) return;
        const disposition = object(data).disposition;
        if (!['started', 'handled', 'queued'].includes(String(disposition))) throw new Error('Invalid Pi prompt disposition');
        if (disposition === 'queued') throw new Error('Pi unexpectedly queued a prompt; steering is not supported');
        turn.accepted = true;
        clearTimeout(turn.preflight);
        if (disposition === 'handled' || turn.settled) {
          const state = this.decodeState(await this.transport.request('get_state'));
          if (this.turn !== turn) return;
          if (state.isStreaming || state.isCompacting || state.pendingMessageCount) { turn.running = true; turn.settled = false; }
          else await this.finish(turn);
        }
      }).catch(error => {
        if (this.turn === turn) {
          turn.error = error as Error;
          if (!turn.accepted && !turn.running) void this.finish(turn);
          else this.fail(error as Error);
        }
      });
    });
  }

  async cancel(): Promise<void> {
    const turn = this.turn;
    if (!turn || turn.cancelled) return;
    turn.cancelled = true;
    clearTimeout(turn.preflight);
    turn.cancelTimer = setTimeout(() => {
      this.options.diagnostic('Pi cancellation deadline exceeded; closing the owned child');
      this.fail(new Error('Pi cancellation deadline exceeded'));
    }, limits.cancelMs);
    await this.interactions.cancelAll();
    await Promise.allSettled(['clear_queue', 'abort_retry', 'abort_bash', 'abort'].map(command => this.transport.request(command, {}, limits.cancelMs)));
    if (this.turn === turn && !turn.running) await this.finish(turn);
  }

  async configure(id: string, value: string | boolean): Promise<SessionConfigOption[]> {
    if (this.dead || this.busy) throw new Error('Configuration changes require an idle healthy session');
    const option = this.config.find(o => o.id === id);
    if (!option || option.type !== 'select' || typeof value !== 'string' ||
        !option.options.some(o => 'value' in o && o.value === value)) throw new Error('Unsupported configuration value');
    this.configBusy = true;
    try {
      if (id === 'model') {
        const [provider, modelId] = z.tuple([z.string(), z.string()]).parse(JSON.parse(value));
        await this.transport.request('set_model', { provider, modelId });
      } else if (id === 'thinking') await this.transport.request('set_thinking_level', { level: value });
      else throw new Error('Unsupported configuration option');
      await this.refresh();
      await this.output.flush();
      return this.config;
    } finally { this.configBusy = false; }
  }

  close(): Promise<void> { return this.closed ??= this.shutdown(); }
  private async shutdown(): Promise<void> {
    if (this.turn) this.turn.cancelled = true;
    const cancellation = this.interactions.cancelAll();
    await this.transport.close();
    await cancellation;
    if (this.turn) await this.finish(this.turn);
    await this.options.release();
  }

  private touch(): void {
    const turn = this.turn;
    if (!turn || turn.accepted || turn.running || turn.cancelled) return;
    clearTimeout(turn.preflight);
    if (this.interactions.size) return;
    turn.preflight = setTimeout(() => this.fail(new Error('Pi prompt preflight timed out')), limits.preflightMs);
  }

  private event(event: PiRecord): void {
    if (this.dead) return;
    this.touch();
    const turn = this.turn;
    if (event.type === 'extension_ui_request') { this.interactions.receive(event); return; }
    this.transcript.event(event);
    if (event.type === 'message_end' || event.type === 'session_info_changed') this.updatedAt = new Date().toISOString();
    if (event.type === 'agent_start') {
      const wasBackground = this.background;
      this.background = true;
      this.backgroundGeneration++;
      if (!turn && !wasBackground) this.transcript = new Transcript(this.cwd, update => this.output.push(update), undefined, this.id);
      if (turn) { turn.running = true; turn.settled = false; clearTimeout(turn.preflight); }
    } else if (event.type === 'message_end' && turn) {
      const message = object(event.message);
      if (message.role === 'assistant' && typeof message.stopReason === 'string') turn.lastStop = message.stopReason;
    } else if (event.type === 'extension_error' && turn) {
      turn.error = new Error('Pi extension command or handler failed');
    } else if (event.type === 'compaction_end' && turn && event.errorMessage && !event.willRetry) {
      turn.error = new Error('Pi compaction failed');
    } else if (event.type === 'auto_retry_end' && turn && event.success === false) {
      turn.error = new Error('Pi retries exhausted');
    } else if (event.type === 'agent_settled') {
      if (turn) { this.background = false; turn.settled = true; if (turn.accepted || turn.cancelled) void this.finish(turn); }
      else {
        const generation = this.backgroundGeneration;
        this.backgroundFlush = this.backgroundFlush.then(async () => {
          if (this.dead) return;
          const state = this.decodeState(await this.transport.request('get_state'));
          if (state.isStreaming || state.isCompacting || state.pendingMessageCount) return;
          this.state = state;
          await this.synchronizeHistory(); await this.refresh();
          this.transcript.finishTools(); await this.output.flush();
          if (generation === this.backgroundGeneration) this.background = false;
        }).catch(error => this.fail(error as Error));
      }
    } else if (event.type === 'session_info_changed') {
      this.output.push({ sessionUpdate: 'session_info_update', title: typeof event.name === 'string' ? event.name.slice(0, 256) : null });
    }
  }

  private async finish(turn: Turn): Promise<void> {
    if (this.turn !== turn || turn.finishing) return;
    turn.finishing = true;
    clearTimeout(turn.preflight);
    try {
      await this.interactions.cancelAll();
      if (!this.dead) {
        const state = this.decodeState(await this.transport.request('get_state'));
        if ((state.isStreaming || state.isCompacting || state.pendingMessageCount) && !turn.cancelled) {
          turn.finishing = false; turn.settled = false; turn.running = true; return;
        }
        this.state = state;
        await this.synchronizeHistory();
        await this.refresh();
      }
      this.transcript.finishTools();
      await this.output.flush();
      if (turn.cancelled || turn.lastStop === 'aborted') turn.resolve('cancelled');
      else if (turn.error || this.dead || turn.lastStop === 'error') turn.reject(turn.error ?? this.dead ?? new Error('Pi provider failed'));
      else turn.resolve(turn.lastStop === 'length' ? 'max_tokens' : 'end_turn');
    } catch (error) {
      this.fail(error as Error);
      if (turn.cancelled) turn.resolve('cancelled'); else turn.reject(error as Error);
    } finally {
      if (turn.finishing) {
        clearTimeout(turn.cancelTimer);
        if (this.turn === turn) this.turn = undefined;
      }
    }
  }

  private decodeState(value: unknown) {
    const state = stateSchema.parse(value);
    if (state.sessionId !== this.id) throw new Error('Pi extension changed session identity; reopen the intended session explicitly');
    return state;
  }
  private async synchronizeHistory(): Promise<void> {
    const data = object(await this.transport.request('get_entries', this.previousEntry ? { since: this.previousEntry } : {}));
    const entries = z.array(z.looseObject({ type: z.string(), id: z.string(), parentId: z.string().nullable(), timestamp: z.string() })).max(limits.historyEntries).parse(data.entries) as Entry[];
    const matched = reconcileAliases(entries, this.transcript.finalized, this.options.aliases, this.previousEntry);
    if (!matched && this.transcript.finalized.length) this.options.diagnostic('Live identity aliases unavailable for this turn; history uses persisted identities');
    if (entries.at(-1)) this.previousEntry = entries.at(-1)!.id;
    await this.persist();
    this.transcript.finalized.length = 0;
  }
  private async persist(): Promise<void> { const info = this.info; if (info) await this.options.storage.save(info, this.options.aliases); }
  private async refresh(): Promise<void> {
    const [state, models, thinking, commands, stats] = await Promise.all([
      this.transport.request('get_state'), this.transport.request('get_available_models'),
      this.transport.request('get_available_thinking_levels'), this.transport.request('get_commands'), this.transport.request('get_session_stats'),
    ]);
    this.state = this.decodeState(state);
    const modelList = z.array(z.looseObject({ provider: z.string(), id: z.string(), name: z.string().optional() })).max(8192).parse(object(models).models);
    const levels = z.array(z.string()).max(16).parse(object(thinking).levels);
    this.config = [];
    if (this.state.model && modelList.length) this.config.push({ id: 'model', name: 'Model', category: 'model', type: 'select',
      currentValue: JSON.stringify([this.state.model.provider, this.state.model.id]),
      options: modelList.map(m => ({ value: JSON.stringify([m.provider, m.id]), name: `${m.name ?? m.id} (${m.provider})` })) });
    if (levels.length) this.config.push({ id: 'thinking', name: 'Thinking', category: 'thought_level', type: 'select',
      currentValue: this.state.thinkingLevel, options: levels.map(level => ({ value: level, name: level })) });
    this.output.push({ sessionUpdate: 'config_option_update', configOptions: this.config });
    const catalog = z.array(z.looseObject({ name: z.string().max(1024), description: z.string().max(4096).optional(), source: z.enum(['extension', 'skill', 'prompt']) })).max(4096).parse(object(commands).commands);
    this.output.push({ sessionUpdate: 'available_commands_update', availableCommands: catalog.map(command => ({
      name: command.name, description: command.description ?? `${command.source} command`, input: { hint: 'Arguments' },
    })) });
    const usage = object(stats).contextUsage;
    if (usage && typeof usage === 'object') {
      const value = object(usage);
      if (typeof value.tokens === 'number' && Number.isFinite(value.tokens) && value.tokens >= 0 &&
          typeof value.contextWindow === 'number' && Number.isFinite(value.contextWindow) && value.contextWindow > 0) {
        this.output.push({ sessionUpdate: 'usage_update', used: value.tokens, size: value.contextWindow });
      }
    }
  }
  private fail(error: Error): void {
    if (this.dead) return;
    this.dead = error;
    this.options.diagnostic(error.message);
    void this.interactions.cancelAll().then(() => this.transport.close()).then(async () => {
      await this.options.release().catch(() => this.options.diagnostic('Session lease cleanup failed'));
      if (this.turn) void this.finish(this.turn);
    });
  }
}

import type { CreateElicitationRequest, CreateElicitationResponse, ElicitationPropertySchema } from '@agentclientprotocol/sdk';
import { boundedText, limits } from './limits.js';
import { object, type PiRecord } from './pi/records.js';

export interface InteractionClient {
  createElicitation(request: CreateElicitationRequest, signal?: AbortSignal): Promise<CreateElicitationResponse>;
}
interface Pending {
  id: string;
  event: PiRecord;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
}

/** Dialog correlation is independent of the prompt response and update queue. */
export class Interactions {
  private readonly pending = new Map<string, Pending>();
  private readonly retired = new Set<string>();
  constructor(private readonly sessionId: string, private readonly client: InteractionClient,
              private readonly supported: boolean, private readonly reply: (response: Record<string, unknown>) => Promise<void>,
              private readonly activity: () => void, private readonly diagnostic: (message: string) => void) {}
  get size(): number { return this.pending.size; }

  receive(event: PiRecord): void {
    if (!['select', 'confirm', 'input', 'editor'].includes(String(event.method))) return;
    const id = boundedText(event.id, 1024, 'interaction id');
    if (this.pending.has(id) || this.retired.has(id)) return;
    if (this.pending.size >= 16) { this.cancelUnregistered(id, 'Too many Pi dialogs'); return; }
    let request: CreateElicitationRequest;
    try { request = this.form(event); }
    catch { this.cancelUnregistered(id, 'Malformed or oversized Pi dialog cancelled'); return; }
    if (!this.supported) { this.cancelUnregistered(id, 'Client lacks ACP form elicitation; Pi dialog cancelled'); return; }
    // Retain only response-validation fields, never arbitrary extension payloads.
    const pending: Pending = { id, event: { type: event.type, method: event.method, options: event.options }, controller: new AbortController() };
    this.pending.set(id, pending);
    this.activity();
    if (event.timeout !== undefined) {
      if (typeof event.timeout !== 'number' || !Number.isSafeInteger(event.timeout) || event.timeout < 1 || event.timeout > 2_147_483_647) {
        void this.finish(id, { cancelled: true }); return;
      }
      // Upstream has no retirement event. Expire locally and never accept a late answer.
      pending.timer = setTimeout(() => { void this.finish(id, { cancelled: true }); }, event.timeout);
    }
    void this.client.createElicitation(request, pending.controller.signal).then(
      response => { if (this.pending.get(id) === pending) void this.answer(pending, response); },
      () => { void this.finish(id, { cancelled: true }); },
    );
  }

  async cancelAll(): Promise<void> {
    await Promise.all([...this.pending.keys()].map(id => this.finish(id, { cancelled: true })));
  }

  private form(event: PiRecord): CreateElicitationRequest {
    const title = boundedText(event.title, limits.answerBytes, 'dialog title');
    let property: ElicitationPropertySchema;
    if (event.method === 'confirm') {
      const description = boundedText(event.message, limits.answerBytes, 'confirmation message');
      property = { type: 'boolean', title, description };
    } else {
      property = { type: 'string', title, maxLength: limits.answerBytes };
      if (event.method === 'select') {
        if (!Array.isArray(event.options) || !event.options.length || event.options.length > limits.options) throw new Error('Invalid options');
        const options = event.options.map(value => boundedText(value, 1024, 'option'));
        if (new Set(options).size !== options.length || Buffer.byteLength(JSON.stringify(options)) > limits.answerBytes) throw new Error('Ambiguous or oversized options');
        property.enum = options;
      } else if (event.method === 'input' && event.placeholder !== undefined) {
        property.description = boundedText(event.placeholder, limits.answerBytes, 'placeholder');
      } else if (event.method === 'editor' && event.prefill !== undefined) {
        property.default = boundedText(event.prefill, limits.answerBytes, 'editor prefill');
        property.description = 'Edit the supplied text. Multi-line presentation depends on your ACP client.';
      }
    }
    return { mode: 'form', sessionId: this.sessionId, message: title,
      requestedSchema: { type: 'object', properties: { answer: property }, required: ['answer'] } };
  }
  private async answer(pending: Pending, response: CreateElicitationResponse): Promise<void> {
    try {
      const value = object(response);
      if (value.action !== 'accept') { await this.finish(pending.id, { cancelled: true }); return; }
      const content = object(value.content);
      const answer = content.answer;
      if (pending.event.method === 'confirm') {
        if (typeof answer !== 'boolean') throw new Error('Invalid confirmation');
        await this.finish(pending.id, { confirmed: answer });
      } else {
        const text = boundedText(answer, limits.answerBytes, 'answer');
        if (pending.event.method === 'select' && !(pending.event.options as unknown[]).includes(text)) throw new Error('Invalid option');
        await this.finish(pending.id, { value: text });
      }
    } catch { await this.finish(pending.id, { cancelled: true }); }
  }
  private async finish(id: string, response: Record<string, unknown>): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.controller.abort();
    this.retire(id);
    this.activity();
    try { await this.reply({ type: 'extension_ui_response', id, ...response }); }
    catch { this.diagnostic('Could not deliver Pi dialog response'); }
  }
  private cancelUnregistered(id: string, message: string): void {
    this.retire(id);
    this.diagnostic(message);
    void this.reply({ type: 'extension_ui_response', id, cancelled: true }).catch(() => this.diagnostic('Could not cancel Pi dialog'));
  }
  private retire(id: string): void {
    this.retired.add(id);
    if (this.retired.size > 1024) this.retired.delete(this.retired.values().next().value!);
  }
}

import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { limits } from './limits.js';

/** Ordered notifications, bounded independently of the continuously running reader. */
export class OutputQueue {
  private tail: Promise<void> = Promise.resolve();
  private count = 0;
  private bytes = 0;
  private error: Error | undefined;
  constructor(private readonly send: (update: SessionUpdate) => Promise<void>, private readonly fail: (error: Error) => void) {}
  push(update: SessionUpdate): void {
    if (this.error) throw this.error;
    const size = Buffer.byteLength(JSON.stringify(update));
    if (this.count + 1 > limits.updateCount || this.bytes + size > limits.updateBytes) throw new Error('ACP update queue limit exceeded');
    this.count++; this.bytes += size;
    this.tail = this.tail.then(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([this.send(update), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('ACP output stalled')), 15_000);
        })]);
      } finally { clearTimeout(timer); this.count--; this.bytes -= size; }
    });
    void this.tail.catch(error => { if (!this.error) { this.error = error as Error; this.fail(this.error); } });
  }
  async flush(): Promise<void> { await this.tail; }
}

import { limits } from '../limits.js';

/** Strict LF records. Buffer bytes until a complete record, then decode UTF-8. */
export class RecordReader {
  private parts: Buffer[] = [];
  private size = 0;
  constructor(private readonly emit: (record: unknown) => void, private readonly max = limits.recordBytes) {}

  push(chunk: Buffer): void {
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 10) continue;
      this.append(chunk.subarray(start, i));
      const bytes = Buffer.concat(this.parts, this.size);
      this.parts = [];
      this.size = 0;
      const end = bytes.at(-1) === 13 ? bytes.length - 1 : bytes.length;
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end));
      if (!text.trim()) throw new Error('Empty Pi protocol record');
      this.emit(JSON.parse(text) as unknown);
      start = i + 1;
    }
    this.append(chunk.subarray(start));
  }

  end(): void {
    if (this.size) throw new Error('Unterminated Pi protocol record');
  }

  private append(part: Buffer): void {
    if (!part.length) return;
    this.size += part.length;
    if (this.size > this.max) throw new Error('Pi protocol record exceeds byte limit');
    // Copy the remainder so it cannot retain an arbitrarily large input chunk.
    this.parts.push(Buffer.from(part));
    if (this.parts.length >= 256) this.parts = [Buffer.concat(this.parts, this.size)];
  }
}

export type PiRecord = Record<string, unknown> & { type: string };
export function record(value: unknown): PiRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof (value as Record<string, unknown>).type !== 'string') {
    throw new Error('Malformed Pi protocol record');
  }
  return value as PiRecord;
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object from Pi');
  return value as Record<string, unknown>;
}

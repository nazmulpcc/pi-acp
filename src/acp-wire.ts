import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { limits } from './limits.js';

export function notificationBytes(sessionId: string, update: SessionUpdate): number {
  return Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } })) + 1;
}

/** The SDK's maxMessageBytes bounds reads only; enforce the same ceiling on writes. */
export function boundedACPOutput(output: WritableStream<Uint8Array>, max = limits.recordBytes): WritableStream<Uint8Array> {
  return new WritableStream({
    async write(chunk) {
      if (chunk.byteLength > max) throw new Error('Outbound ACP record exceeds wire limit');
      const writer = output.getWriter();
      try { await writer.write(chunk); } finally { writer.releaseLock(); }
    },
  });
}

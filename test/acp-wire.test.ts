import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundedACPOutput } from '../src/acp-wire.js';

test('complete encoded outbound records are bounded before any bytes reach stdout', async () => {
  const received: Uint8Array[] = [];
  const output = boundedACPOutput(new WritableStream<Uint8Array>({ write(chunk) { received.push(chunk); } }), 8);
  const writer = output.getWriter();
  await writer.write(new TextEncoder().encode('{}\n'));
  await assert.rejects(writer.write(new TextEncoder().encode('12345678\n')), /wire limit/);
  assert.equal(received.length, 1);
  assert.equal(received[0]!.byteLength, 3);
});

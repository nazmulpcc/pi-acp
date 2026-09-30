import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecordReader } from '../src/pi/records.js';
import { PiTransport } from '../src/pi/transport.js';

test('LF framing retains fragmented UTF-8 and Unicode separators', () => {
  const records: unknown[] = [];
  const reader = new RecordReader(value => records.push(value));
  const input = Buffer.from('{"text":"hi 🦊\u2028\u2029"}\r\n{"text":"next"}\n');
  for (const byte of input) reader.push(Buffer.from([byte]));
  reader.end();
  assert.deepEqual(records, [{ text: 'hi 🦊\u2028\u2029' }, { text: 'next' }]);
});

test('limits and malformed UTF-8 fail before JSON allocation', () => {
  assert.throws(() => new RecordReader(() => {}, 4).push(Buffer.from('12345')), /limit/);
  assert.throws(() => new RecordReader(() => {}).push(Buffer.from([255, 10])));
  const reader = new RecordReader(() => {}); reader.push(Buffer.from('{}'));
  assert.throws(() => reader.end(), /Unterminated/);
});

function fake(script: string): PiTransport {
  return new PiTransport({ executable: process.execPath, cwd: process.cwd(), args: ['-e', script] });
}

test('responses correlate by id despite reordered arrival; retired responses are ignored', async () => {
  const transport = fake(`let a=[];require('readline').createInterface({input:process.stdin}).on('line',l=>{a.push(JSON.parse(l));if(a.length===2) for(const r of a.reverse()) process.stdout.write(JSON.stringify({type:'response',id:r.id,command:r.type,success:true,data:r.type})+'\\n')});`);
  try {
    assert.deepEqual(await Promise.all([transport.request('first'), transport.request('second')]), ['first', 'second']);
  } finally { await transport.close(); }
});

test('mismatched response poisons generation and releases all pending work', async () => {
  const transport = fake(`require('readline').createInterface({input:process.stdin}).on('line',l=>{const r=JSON.parse(l);process.stdout.write(JSON.stringify({type:'response',id:r.id,command:'wrong',success:true})+'\\n')});`);
  try { await assert.rejects(transport.request('get_state'), /protocol/); assert.equal(transport.alive, false); }
  finally { await transport.close(); }
});

test('child death rejects pending requests and close is idempotent', async () => {
  const transport = fake('process.stdin.once("data",()=>process.exit(9))');
  await assert.rejects(transport.request('get_state'), /closed|exited/);
  await Promise.all([transport.close(), transport.close()]);
});

test('timeout retires a request without poisoning other controls', async () => {
  const transport = fake(`require('readline').createInterface({input:process.stdin}).on('line',l=>{const r=JSON.parse(l);setTimeout(()=>process.stdout.write(JSON.stringify({type:'response',id:r.id,command:r.type,success:true,data:42})+'\\n'),r.type==='slow'?70:0)});`);
  try {
    await assert.rejects(transport.request('slow', {}, 20), /timed out/);
    assert.equal(await transport.request('fast'), 42);
  } finally { await transport.close(); }
});

test('backpressured command writes stay bounded while inbound events continue', { timeout: 5000 }, async () => {
  const transport = fake(`process.stdout.write('{"type":"fixture_ready"}\\n');setInterval(()=>{},1000);`);
  const event = new Promise<void>(r => transport.onEvent(e => { if (e.type === 'fixture_ready') r(); }));
  const writes = Array.from({ length: 64 }, () => transport.send({ type: 'fixture', data: 'x'.repeat(64 * 1024) }).catch(() => {}));
  await assert.rejects(transport.send({ type: 'overflow' }), /queue/);
  await event;
  await transport.close(); await Promise.all(writes);
});

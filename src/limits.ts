export const limits = Object.freeze({
  recordBytes: 16 * 1024 * 1024,
  pendingRequests: 64,
  controlMs: 10_000,
  startupMs: 30_000,
  preflightMs: 30_000,
  cancelMs: 5_000,
  shutdownMs: 1_000,
  promptBytes: 1024 * 1024,
  imageBytes: 8 * 1024 * 1024,
  turnBytes: 16 * 1024 * 1024,
  updateBytes: 1024 * 1024,
  updateCount: 1024,
  outputBytes: 512 * 1024,
  previewBytes: 256 * 1024,
  historyFileBytes: 64 * 1024 * 1024,
  historyEntries: 100_000,
  replayBytes: 8 * 1024 * 1024,
  discoveryFiles: 10_000,
  discoveryMs: 5_000,
  sessions: 16,
  answerBytes: 64 * 1024,
  options: 256,
});

export function boundedText(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > max) {
    throw new Error(`Invalid or oversized ${label}`);
  }
  return value;
}

export function truncate(text: string, max = limits.outputBytes): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= max) return text;
  // Avoid cutting a UTF-8 code point; the suffix also fits inside the bound.
  const suffix = '\n[Output truncated by adapter]';
  let end = max - Buffer.byteLength(suffix);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8') + suffix;
}

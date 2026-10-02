/** Bounded display projection; Pi retains the complete original name. */
export function sessionTitle(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined;
  const bytes = Buffer.from(name.trim());
  let end = Math.min(bytes.length, 256);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8') || undefined;
}

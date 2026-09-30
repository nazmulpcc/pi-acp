import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';

/** Refuse links/devices before opening, and avoid blocking on a raced-in FIFO. */
export async function openRegular(path: string, max = Infinity): Promise<FileHandle> {
  const before = await lstat(path);
  if (!before.isFile() || before.size > max) throw new Error('File is nonregular or exceeds the read limit');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const after = await handle.stat();
    if (!after.isFile() || after.size > max || after.ino !== before.ino || after.dev !== before.dev) {
      throw new Error('File changed during open or exceeds the read limit');
    }
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

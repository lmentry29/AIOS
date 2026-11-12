import { closeSync, fsyncSync, openSync } from "node:fs";

/**
 * Makes a completed rename durable on filesystems that support directory fsync.
 *
 * Some platforms/filesystems reject directory fsync. The file itself has already been
 * fsynced before the rename, so an unsupported directory fsync is not converted into a
 * false success claim; the caller's append/export remains durable at the file level.
 */
function isUnsupportedDirectoryFsync(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EISDIR";
}

export function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch (error) {
    // Some platforms/filesystems do not support directory fsync. Any other failure is a
    // real durability error and must not be converted into a successful export claim.
    if (!isUnsupportedDirectoryFsync(error)) throw error;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        /* best effort */
      }
    }
  }
}

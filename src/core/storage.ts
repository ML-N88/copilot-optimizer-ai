import * as path from "path";
import * as fs from "fs";

/**
 * Central location for the extension's *writable* learning data
 * (logs, node weights, strategy cache).
 *
 * When installed from the Marketplace the extension's own install folder is
 * READ-ONLY, so writing into the bundled `data/` directory silently fails and
 * the "learns over time" feature never persists. To fix that, the host sets
 * this to `context.globalStorageUri.fsPath` during activation — a per-user,
 * writable location that survives updates.
 *
 * Falls back to the bundled `data/` folder (writable in F5/dev) when the host
 * hasn't configured a path, so unit/dev usage keeps working unchanged.
 */
let storageDir: string | undefined;

/** Configure the writable storage directory. Called once from activate(). */
export function setStorageDir(dir: string): void {
  storageDir = dir;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* directory may already exist or be uncreatable — callers handle I/O errors */
  }
}

/** Resolve the absolute path of a writable data file by name. */
export function getStoragePath(fileName: string): string {
  if (storageDir) return path.join(storageDir, fileName);
  // Dev/test fallback: the bundled data/ folder next to the compiled output.
  return path.join(__dirname, "..", "..", "data", fileName);
}

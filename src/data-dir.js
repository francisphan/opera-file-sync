const path = require('path');

/**
 * Resolves writable runtime files (sync-state.json, daily-stats.json,
 * villa-map.json) to a stable on-disk directory.
 *
 * Why not path.resolve(name) / process.cwd(): when bundled with pkg and run
 * as a Windows service, process.cwd() can resolve into pkg's read-only
 * virtual filesystem (C:\snapshot\...), producing ENOENT on write. Anchoring
 * to the executable's own directory (process.execPath) keeps these files next
 * to the .exe (e.g. D:\opera-sf-sync\), regardless of how the service is
 * launched or what cwd NSSM hands us.
 *
 * SYNC_DATA_DIR overrides the base directory if set.
 * In dev (unbundled) we fall back to cwd, preserving existing behavior/tests.
 */
function baseDir() {
  if (process.env.SYNC_DATA_DIR) return process.env.SYNC_DATA_DIR;
  if (process.pkg) return path.dirname(process.execPath);
  return process.cwd();
}

function dataPath(fileName) {
  return path.join(baseDir(), fileName);
}

module.exports = { dataPath, baseDir };

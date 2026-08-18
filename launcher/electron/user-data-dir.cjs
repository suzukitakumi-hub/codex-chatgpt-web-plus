const os = require("node:os");
const path = require("node:path");

// The rebrand target: Electron's `userData` directory lives here once resolved/migrated.
const PRODUCT_DATA_DIR_NAME = "Codex Master";

// Legacy directory names this app's userData has used, in strict migration priority order.
// "Codex ChatGPT Web Plus" is the live pre-rebrand name (holds the current ChatGPT login on most
// installs); "Codex Web GPT" is an older pre-rebrand name some installs still carry. Only the
// first one found is migrated — never both, and never merged.
const LEGACY_DATA_DIR_NAMES = ["Codex ChatGPT Web Plus", "Codex Web GPT"];

function expandUserPath(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

// Resolves the userData directory for this app and migrates a legacy pre-rebrand directory to
// the new product name on first run, without ever losing the user's existing login or launcher
// state. Aside from the injected fs functions this is a pure function of its inputs, so every
// branch (env override / already migrated / needs migration / migration failure) is unit
// testable without touching real disk or Electron.
//
// `existsSync`/`renameSync` are injected (rather than required from "node:fs" directly) so tests
// can exercise failure paths (e.g. a rename that throws) deterministically. This runs before the
// logger exists, so the outcome is returned as a value for the caller to log once it can.
function resolveUserDataDir({ appDataRoot, envOverride, existsSync, renameSync }) {
  const trimmedOverride = typeof envOverride === "string" ? envOverride.trim() : "";
  if (trimmedOverride) {
    // Honored exactly as before the rebrand: no migration is consulted at all.
    return { dir: expandUserPath(trimmedOverride), outcome: "env-override", detail: null };
  }

  const target = path.join(appDataRoot, PRODUCT_DATA_DIR_NAME);
  if (existsSync(target)) {
    return { dir: target, outcome: "already-current", detail: null };
  }

  for (const legacyName of LEGACY_DATA_DIR_NAMES) {
    const legacyPath = path.join(appDataRoot, legacyName);
    if (!existsSync(legacyPath)) continue;
    try {
      renameSync(legacyPath, target);
      return { dir: target, outcome: "migrated", detail: legacyName };
    } catch (error) {
      // Fail-safe: a stale lock or a cross-volume appData move must never crash startup and must
      // never silently start fresh with an empty profile. Keep serving the legacy directory this
      // run; the directory itself is left untouched (renameSync did not partially apply).
      const message = error instanceof Error ? error.message : String(error);
      return {
        dir: legacyPath,
        outcome: "migration-failed",
        detail: `${legacyName}: ${message}`,
      };
    }
  }

  return { dir: target, outcome: "fresh-install", detail: null };
}

module.exports = {
  LEGACY_DATA_DIR_NAMES,
  PRODUCT_DATA_DIR_NAME,
  resolveUserDataDir,
};

// Low-level, secrets-agnostic read-modify-write helpers for ~/.codex-switcher/accounts.json,
// shared by credential-provider.cjs (persisting a refreshed token) and credential-import.cjs
// (adopting fresh credentials from ~/.codex/auth.json, or adding a brand-new account). Both need
// the exact same safety guarantees -- read the whole file fresh immediately before writing,
// preserve every account and every field this process does not understand, back up the previous
// contents, write atomically -- so the mechanics live here once instead of twice.
//
// This module never inspects auth_data itself: it only knows about the file's top-level shape
// (`{ version, accounts: [...], active_account_id, masked_account_ids, ... }`). Callers own the
// per-account credential fields.
const fs = require("node:fs");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

// Fresh read every time -- never cached -- so a caller can never act on a stale snapshot of an
// account's credentials. Returns a default empty root (never throws) when the file does not exist
// yet: that is the normal, expected state before the very first account has ever been imported or
// switched to on this machine.
function readAccountsRoot(accountsPath) {
  let text;
  try {
    text = fs.readFileSync(accountsPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { version: 1, accounts: [], active_account_id: null, masked_account_ids: [] };
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Codex Switcher accounts file is invalid JSON: ${accountsPath}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.accounts)) {
    throw new Error(`Codex Switcher accounts file has an unexpected shape: ${accountsPath}`);
  }
  return parsed;
}

// Writes `root` back to `accountsPath` atomically. Before doing so, best-effort backs up whatever
// was previously there to `${accountsPath}.bak` -- matching the exact convention this codebase
// already uses for auth.json (see backupExistingAuthFile in accounts.cjs) and the one Codex
// Switcher Plus's own writer used for this same file upstream (atomic_write_with_backup in
// src-tauri/src/fsutil.rs): the backup is deliberately best-effort (a failed backup must never
// block the write the caller actually asked for), but the write itself is not -- writeAtomic
// (writePrivateFileAtomic by default) throws normally on failure, and that failure must propagate
// to the caller so a refresh/import that could not be durably persisted never hands out whatever
// it was about to save. `root` is written exactly as given (only reformatted as pretty-printed
// JSON, matching the auth.json writer's own style) -- callers are responsible for not dropping any
// field they did not intend to touch.
function writeAccountsRoot(accountsPath, root, { writeAtomic = writePrivateFileAtomic } = {}) {
  try {
    if (fs.existsSync(accountsPath)) {
      const backupPath = `${accountsPath}.bak`;
      fs.copyFileSync(accountsPath, backupPath);
      try { fs.chmodSync(backupPath, 0o600); } catch {}
    }
  } catch {
    // Best-effort by design; see comment above.
  }
  writeAtomic(accountsPath, `${JSON.stringify(root, null, 2)}\n`);
}

module.exports = {
  readAccountsRoot,
  writeAccountsRoot,
};

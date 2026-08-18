const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  LEGACY_DATA_DIR_NAMES,
  PRODUCT_DATA_DIR_NAME,
  resolveUserDataDir,
} = require("../electron/user-data-dir.cjs");

const APP_DATA_ROOT = path.join("C:", "fake-appdata");

function existsFactory(existing) {
  const set = new Set(existing);
  return (candidate) => set.has(candidate);
}

function failingFn(label) {
  return () => { throw new Error(`${label} must not be called`); };
}

test("resolveUserDataDir uses the new directory as-is when it already exists (new-exists)", () => {
  const target = path.join(APP_DATA_ROOT, PRODUCT_DATA_DIR_NAME);
  const result = resolveUserDataDir({
    appDataRoot: APP_DATA_ROOT,
    envOverride: undefined,
    existsSync: existsFactory([target]),
    renameSync: failingFn("renameSync"),
  });
  assert.deepEqual(result, { dir: target, outcome: "already-current", detail: null });
});

test("resolveUserDataDir prefers legacy 'Codex ChatGPT Web Plus' over legacy 'Codex Web GPT'", () => {
  const target = path.join(APP_DATA_ROOT, PRODUCT_DATA_DIR_NAME);
  const legacyPlus = path.join(APP_DATA_ROOT, "Codex ChatGPT Web Plus");
  const legacyWebGpt = path.join(APP_DATA_ROOT, "Codex Web GPT");
  const renamed = [];
  const result = resolveUserDataDir({
    appDataRoot: APP_DATA_ROOT,
    envOverride: undefined,
    existsSync: existsFactory([legacyPlus, legacyWebGpt]),
    renameSync: (from, to) => renamed.push([from, to]),
  });
  assert.deepEqual(result, { dir: target, outcome: "migrated", detail: "Codex ChatGPT Web Plus" });
  assert.deepEqual(renamed, [[legacyPlus, target]]);
  assert.equal(LEGACY_DATA_DIR_NAMES[0], "Codex ChatGPT Web Plus");
  assert.equal(LEGACY_DATA_DIR_NAMES[1], "Codex Web GPT");
});

test("resolveUserDataDir migrates the only legacy directory present when it is 'Codex Web GPT'", () => {
  const target = path.join(APP_DATA_ROOT, PRODUCT_DATA_DIR_NAME);
  const legacyWebGpt = path.join(APP_DATA_ROOT, "Codex Web GPT");
  const renamed = [];
  const result = resolveUserDataDir({
    appDataRoot: APP_DATA_ROOT,
    envOverride: undefined,
    existsSync: existsFactory([legacyWebGpt]),
    renameSync: (from, to) => renamed.push([from, to]),
  });
  assert.deepEqual(result, { dir: target, outcome: "migrated", detail: "Codex Web GPT" });
  assert.deepEqual(renamed, [[legacyWebGpt, target]]);
});

test("resolveUserDataDir falls back to the legacy directory when rename fails, without deleting it", () => {
  const legacyPlus = path.join(APP_DATA_ROOT, "Codex ChatGPT Web Plus");
  const result = resolveUserDataDir({
    appDataRoot: APP_DATA_ROOT,
    envOverride: undefined,
    existsSync: existsFactory([legacyPlus]),
    renameSync: () => { throw new Error("EXDEV: cross-device link not permitted"); },
  });
  assert.equal(result.dir, legacyPlus);
  assert.equal(result.outcome, "migration-failed");
  assert.match(result.detail, /Codex ChatGPT Web Plus/);
  assert.match(result.detail, /cross-device/);
});

test("resolveUserDataDir honors the env override exactly and skips migration entirely", () => {
  const result = resolveUserDataDir({
    appDataRoot: APP_DATA_ROOT,
    envOverride: "  /custom/launcher-data  ",
    existsSync: failingFn("existsSync"),
    renameSync: failingFn("renameSync"),
  });
  assert.equal(result.outcome, "env-override");
  assert.equal(result.dir, path.resolve("/custom/launcher-data"));
});

test("resolveUserDataDir starts fresh under the new name when nothing exists yet", () => {
  const target = path.join(APP_DATA_ROOT, PRODUCT_DATA_DIR_NAME);
  const result = resolveUserDataDir({
    appDataRoot: APP_DATA_ROOT,
    envOverride: undefined,
    existsSync: existsFactory([]),
    renameSync: failingFn("renameSync"),
  });
  assert.deepEqual(result, { dir: target, outcome: "fresh-install", detail: null });
});

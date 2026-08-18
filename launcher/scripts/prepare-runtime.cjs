const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const launcherRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(launcherRoot, "..");
const output = path.join(launcherRoot, "build", "runtime");
// Bun selection for the bundled runtime.
//
// Stable Bun 1.3.14 segfaults in its stream sink (Sink.write -> streams.zig ->
// appendSliceAssumeCapacity, faulting in memcpy at 0xFFFFFFFFFFFFFFFF) while the proxy streams
// responses back to Codex. Measured on Windows: 51-75 daemon crashes per hour during normal use,
// surfacing in Codex as a "reconnecting" between almost every tool call. Both the baseline and the
// AVX2 build of 1.3.14 crash; 1.4.0-canary does not. So prefer a vendored canary when one is
// present. The binary itself is deliberately gitignored (~89MB); drop it at the path below, or
// point CODEX_WEB_GPT_BUN at any Bun you want the runtime built with.
const vendoredBun = path.join(repositoryRoot, "vendor", "bun", process.platform === "win32" ? "bun-windows-x64.exe" : "bun");
const bun = process.env.CODEX_WEB_GPT_BUN || process.execPath;
// The bundler itself must run on the pinned Bun (it asserts Bun.version), but the binary it
// EMBEDS may differ -- that is how the canary ships without moving the pin.
const embeddedBun = process.env.CODEX_CHATGPT_WEB_EMBEDDED_BUN
  || (fs.existsSync(vendoredBun) ? vendoredBun : undefined);
if (embeddedBun) console.log(`[prepare-runtime] embedding Bun: ${embeddedBun}`);

const result = spawnSync(bun, ["run", "scripts/build-runtime-bundle.ts", output], {
  cwd: repositoryRoot,
  env: embeddedBun ? { ...process.env, CODEX_CHATGPT_WEB_EMBEDDED_BUN: embeddedBun } : process.env,
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const notices = spawnSync(bun, [
  "run",
  "scripts/generate-third-party-notices.ts",
  path.join(output, "THIRD_PARTY_NOTICES.txt"),
  "--include-launcher",
], {
  cwd: repositoryRoot,
  env: process.env,
  stdio: "inherit",
});
if (notices.error) throw notices.error;
if (notices.status !== 0) process.exit(notices.status ?? 1);
fs.copyFileSync(path.join(repositoryRoot, "LICENSE"), path.join(output, "LICENSE"));
fs.cpSync(path.join(repositoryRoot, "LICENSES"), path.join(output, "LICENSES"), { recursive: true });

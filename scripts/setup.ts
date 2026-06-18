#!/usr/bin/env bun
/**
 * personal-OS — First-run setup detection + server launch
 *
 * Called by SessionStart hook:
 *   bun scripts/setup.ts --check && bun scripts/collect.ts
 *
 * --check mode:
 *   - If setup complete: exits 0
 *   - If not complete: starts server (detached), opens browser, exits 0
 *     The server shuts itself down after setup completes.
 */

import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from "fs";
import { isSetupComplete, getConfigDir } from "../connectors/_shared/vault";
import { join } from "path";
import { spawnSync } from "child_process";

const PROJECT_ROOT = join(import.meta.dir, "..");

/**
 * Ensure node_modules is populated. The server and connectors import npm
 * packages (hono, telegram, MCP SDK), so we install on first run rather
 * than asking the user to.
 */
function ensureDependencies(): void {
  if (existsSync(join(PROJECT_ROOT, "node_modules"))) return;
  if (!existsSync(join(PROJECT_ROOT, "package.json"))) return;

  console.log("personal-OS: installing dependencies (one-time, ~30s)...\n");
  const result = spawnSync("bun", ["install"], {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error("\nDependency installation failed. Try running 'bun install' manually.");
    process.exit(1);
  }
  console.log("");
}

const isCheck = process.argv.includes("--check");

if (isCheck) {
  ensureDependencies();

  if (isSetupComplete()) {
    process.exit(0);
  }

  const configDir = getConfigDir();
  mkdirSync(configDir, { recursive: true });
  const pidFile = join(configDir, "server.pid");

  // Kill any stale server from a previous run
  if (existsSync(pidFile)) {
    try {
      const oldPid = parseInt(readFileSync(pidFile, "utf-8").trim());
      process.kill(oldPid, "SIGTERM");
    } catch {}
    unlinkSync(pidFile);
  }

  // Start server detached so it outlives this script
  const serverProc = Bun.spawn(["bun", "scripts/server/index.ts"], {
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env },
  });
  serverProc.unref();

  // Save PID for cleanup
  writeFileSync(pidFile, String(serverProc.pid));

  // Wait briefly for server to start
  await Bun.sleep(1500);

  // Open browser
  Bun.spawn(["open", "http://localhost:3847/setup"], { stdio: ["ignore", "ignore", "ignore"] });

  console.log("Finish the setup form and restart the claude by /exit");

  // Exit 0 so the SessionStart hook doesn't surface a "startup hook error".
  // bootstrap.sh inspects the config file to decide whether to run collect.ts.
  process.exit(0);
}

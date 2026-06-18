#!/usr/bin/env bun
/**
 * personal-OS — SessionStart data collection orchestrator
 *
 * Collects from custom connectors (Telegram, Twitter, Granola) in parallel.
 * Built-in MCPs (Gmail) are collected by Claude after this hook completes.
 *
 * Called by SessionStart hook after setup.ts --check passes.
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const HOME = homedir();
const CONFIG_DIR = join(HOME, ".cyboslite");
const CONNECTORS_JSON = join(CONFIG_DIR, "connectors.json");
const PROJECT_ROOT = join(import.meta.dir, "..");

interface ConnectorConfig {
  custom_connectors: Record<string, { enabled: boolean; version: string }>;
  builtin_mcps: Record<string, { required: boolean; connected: boolean }>;
}

interface CollectionResult {
  connector: string;
  success: boolean;
  newItems: number;
  message: string;
  durationMs: number;
}

function getConnectorConfig(): ConnectorConfig | null {
  if (!existsSync(CONNECTORS_JSON)) return null;
  try {
    return JSON.parse(readFileSync(CONNECTORS_JSON, "utf-8"));
  } catch {
    return null;
  }
}

async function collectTelegram(): Promise<CollectionResult> {
  const start = Date.now();
  try {
    const result = spawnSync(
      "bun",
      [join(PROJECT_ROOT, "connectors/telegram/mcp/server.ts"), "--collect"],
      { stdio: ["pipe", "pipe", "pipe"], timeout: 120_000, env: process.env }
    );

    if (result.status !== 0) {
      const err = result.stderr?.toString().trim() || "Unknown error";
      return {
        connector: "telegram",
        success: false,
        newItems: 0,
        message: err.slice(0, 200),
        durationMs: Date.now() - start,
      };
    }

    const output = result.stdout?.toString() || "";
    const match = output.match(/(\d+) dialog/);
    const count = match ? parseInt(match[1]) : 0;

    return {
      connector: "telegram",
      success: true,
      newItems: count,
      message: `${count} dialogs synced`,
      durationMs: Date.now() - start,
    };
  } catch (e: any) {
    return {
      connector: "telegram",
      success: false,
      newItems: 0,
      message: e.message,
      durationMs: Date.now() - start,
    };
  }
}

async function collectTwitter(): Promise<CollectionResult> {
  const start = Date.now();
  try {
    const result = spawnSync(
      "bun",
      [join(PROJECT_ROOT, "connectors/twitter/mcp/server.ts"), "--collect"],
      { stdio: ["pipe", "pipe", "pipe"], timeout: 60_000, env: process.env }
    );

    if (result.status !== 0) {
      const err = result.stderr?.toString().trim() || "Failed";
      return {
        connector: "twitter",
        success: false,
        newItems: 0,
        message: err.slice(0, 200),
        durationMs: Date.now() - start,
      };
    }

    const output = result.stdout?.toString() || "";
    const match = output.match(/(\d+) posts?/);
    const count = match ? parseInt(match[1]) : 0;

    return {
      connector: "twitter",
      success: true,
      newItems: count,
      message: `${count} posts fetched`,
      durationMs: Date.now() - start,
    };
  } catch (e: any) {
    return {
      connector: "twitter",
      success: false,
      newItems: 0,
      message: e.message,
      durationMs: Date.now() - start,
    };
  }
}

async function collectGranola(): Promise<CollectionResult> {
  const start = Date.now();
  try {
    const result = spawnSync(
      "bun",
      [join(PROJECT_ROOT, "connectors/granola/mcp/server.ts"), "--collect"],
      { stdio: ["pipe", "pipe", "pipe"], timeout: 120_000, env: process.env }
    );

    if (result.status !== 0) {
      const err = result.stderr?.toString().trim() || "Failed";
      return {
        connector: "granola",
        success: false,
        newItems: 0,
        message: err.slice(0, 200),
        durationMs: Date.now() - start,
      };
    }

    const output = result.stdout?.toString() || "";
    const match = output.match(/(\d+) calls? extracted/);
    const count = match ? parseInt(match[1]) : 0;
    const noApiKey = output.includes("no API key");

    return {
      connector: "granola",
      success: !noApiKey,
      newItems: count,
      message: noApiKey ? "API key not configured" : (output.split("\n").find((l) => l.startsWith("Granola:")) || `${count} calls extracted`),
      durationMs: Date.now() - start,
    };
  } catch (e: any) {
    return {
      connector: "granola",
      success: false,
      newItems: 0,
      message: e.message,
      durationMs: Date.now() - start,
    };
  }
}

async function collectGmail(): Promise<CollectionResult> {
  const start = Date.now();
  try {
    const result = spawnSync(
      "bun",
      [join(PROJECT_ROOT, "connectors/gmail/mcp/server.ts"), "--collect"],
      { stdio: ["pipe", "pipe", "pipe"], timeout: 90_000, env: process.env }
    );

    if (result.status !== 0) {
      const err = result.stderr?.toString().trim() || "Failed";
      return {
        connector: "gmail",
        success: false,
        newItems: 0,
        message: err.slice(0, 200),
        durationMs: Date.now() - start,
      };
    }

    const output = result.stdout?.toString() || "";
    const match = output.match(/(\d+) email/);
    const count = match ? parseInt(match[1]) : 0;

    return {
      connector: "gmail",
      success: true,
      newItems: count,
      message: `${count} emails synced`,
      durationMs: Date.now() - start,
    };
  } catch (e: any) {
    return {
      connector: "gmail",
      success: false,
      newItems: 0,
      message: e.message,
      durationMs: Date.now() - start,
    };
  }
}

async function main() {
  const config = getConnectorConfig();
  if (!config) {
    console.log("cybOS collection: no connectors.json found, skipping.");
    process.exit(0);
  }

  const tasks: Promise<CollectionResult>[] = [];

  if (config.custom_connectors?.telegram?.enabled) {
    tasks.push(collectTelegram());
  }
  if (config.custom_connectors?.twitter?.enabled) {
    tasks.push(collectTwitter());
  }
  if (config.custom_connectors?.gmail?.enabled) {
    tasks.push(collectGmail());
  }
  if (config.custom_connectors?.granola?.enabled) {
    tasks.push(collectGranola());
  }

  if (tasks.length === 0) {
    console.log("cybOS collection: no custom connectors enabled.");
    process.exit(0);
  }

  const results = await Promise.allSettled(tasks);
  const settled = results.map((r) =>
    r.status === "fulfilled"
      ? r.value
      : {
          connector: "unknown",
          success: false,
          newItems: 0,
          message: (r.reason as Error).message,
          durationMs: 0,
        }
  );

  // Build summary lines
  const lines: string[] = [];
  lines.push("cybOS data collection complete:");
  for (const r of settled) {
    const icon = r.success ? "+" : "!";
    lines.push(`  [${icon}] ${r.connector}: ${r.message} (${r.durationMs}ms)`);
  }
  lines.push("");
  lines.push("Reminder: run /cyber-twitter to create and schedule new posts.");
  lines.push("");

  const summary = lines.join("\n");

  // Output JSON for Claude Code hook runner:
  // - additionalContext → injected into Claude's context as <system-reminder>
  // - systemMessage → displayed to the user in the console
  const additionalContext = `SessionStart:startup hook success: ${summary}`;

  const hookOutput = {
    additionalContext,
    systemMessage: summary,
  };
  console.log(JSON.stringify(hookOutput));

}

main().catch((e) => {
  console.error("Collection failed:", e.message);
  process.exit(1);
});

#!/usr/bin/env bun
/**
 * Auto-generate .mcp.json from connector registry
 * Only custom connectors are added — built-in MCPs are managed by Claude.ai
 */

import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const HOME = homedir();
const CONFIG_DIR = join(HOME, ".cyboslite");
const CONNECTORS_JSON = join(CONFIG_DIR, "connectors.json");
const PROJECT_ROOT = join(import.meta.dir, "..");
const MCP_JSON = join(PROJECT_ROOT, ".mcp.json");
const CONNECTORS_DIR = join(PROJECT_ROOT, "connectors");

interface McpConfig {
  mcpServers: Record<string, {
    command: string;
    args: string[];
    env: Record<string, string>;
  }>;
}

function main() {
  const mcpConfig: McpConfig = { mcpServers: {} };

  // Read connectors.json if it exists
  let connectorConfig: any = { custom_connectors: {} };
  if (existsSync(CONNECTORS_JSON)) {
    connectorConfig = JSON.parse(readFileSync(CONNECTORS_JSON, "utf-8"));
  }

  // Scan connectors directory for connector.json files
  const connectorDirs = readdirSync(CONNECTORS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
    .map((d) => d.name);

  for (const name of connectorDirs) {
    const connectorJsonPath = join(CONNECTORS_DIR, name, "mcp", "connector.json");
    const serverPath = join(CONNECTORS_DIR, name, "mcp", "server.ts");

    if (!existsSync(connectorJsonPath) || !existsSync(serverPath)) continue;

    // Check if enabled in connectors.json
    const isEnabled = connectorConfig.custom_connectors?.[name]?.enabled !== false;
    if (!isEnabled) continue;

    mcpConfig.mcpServers[`cybos-${name}`] = {
      command: "bun",
      args: [`connectors/${name}/mcp/server.ts`],
      env: {},
    };
  }

  writeFileSync(MCP_JSON, JSON.stringify(mcpConfig, null, 2));
  console.log(`Generated .mcp.json with ${Object.keys(mcpConfig.mcpServers).length} connector(s):`);
  for (const name of Object.keys(mcpConfig.mcpServers)) {
    console.log(`  - ${name}`);
  }
}

main();

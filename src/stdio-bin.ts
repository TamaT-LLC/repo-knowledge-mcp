#!/usr/bin/env node

import { createStderrLogger } from "./mcp-server.js";
import { serveDefaultRepoKnowledgeStdio } from "./stdio-entry.js";

const logger = createStderrLogger();

try {
  await serveDefaultRepoKnowledgeStdio();
} catch (error) {
  logger.error({ err: error }, "Failed to start MCP stdio server");
  process.exitCode = 1;
}

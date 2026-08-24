/**
 * Stable programmatic entry point for the supported repo-knowledge CLI.
 *
 * All other implementation exports are intentionally available only through
 * the unsupported `@tamat-llc/repo-knowledge-mcp/experimental` migration path.
 */
export {
  runDefaultRepoKnowledgeCli,
  type RunDefaultRepoKnowledgeCliOptions,
} from "./cli-runtime.js";

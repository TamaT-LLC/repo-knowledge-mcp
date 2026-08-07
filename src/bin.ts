#!/usr/bin/env node

import { runDefaultRepoKnowledgeCli } from "./cli-runtime.js";

process.exitCode = await runDefaultRepoKnowledgeCli();

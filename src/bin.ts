#!/usr/bin/env node

import { runDefaultRepoKnowledgeCli } from "./cli-runtime.js";
import { enableCompileWhenHot } from "./zod-compile-when-hot.js";

enableCompileWhenHot();
process.exitCode = await runDefaultRepoKnowledgeCli();

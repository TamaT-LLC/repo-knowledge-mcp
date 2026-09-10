import { runQualityGateCli } from "./quality-gate-command.js";

process.exitCode = await runQualityGateCli(process.argv.slice(2));

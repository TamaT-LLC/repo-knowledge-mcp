import { runGoldenBaselineCli } from "./golden-baseline-command.js";

process.exitCode = await runGoldenBaselineCli(process.argv.slice(2));

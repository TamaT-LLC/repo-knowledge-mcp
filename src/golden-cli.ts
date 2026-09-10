import { runGoldenCli } from "./golden-command.js";

process.exitCode = await runGoldenCli(process.argv.slice(2));

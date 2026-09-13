import { runPilotDailyRecordCli } from "./pilot-daily-record-command.js";

process.exitCode = await runPilotDailyRecordCli(process.argv.slice(2));

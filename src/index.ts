import { parseBackupArgs, parseRestoreArgs, runBackup, runRestore } from "./cli/backup.ts";
import { parseInstallArgs, runInstall } from "./cli/install.ts";
import { parseServeArgs, startServe } from "./cli/serve.ts";
import { runSetup } from "./cli/setup.ts";
import { runStatus } from "./cli/status.ts";
import { parseUsageArgs, runUsage } from "./cli/usage.ts";
import { runDemo } from "./demo/runner.ts";

function printHelp() {
  console.log(`
AA Book: The installable front desk booking agent (CLI)

Usage:
  aabook <command> [options]

Commands:
  install       Check Bun version, install dependencies, and scaffold client/ & data/ (--service writes OS service unit)
  setup         Interactive configuration wizard to create business/services/staff/persona/policies/channels
  status        Check health and inspect current client configuration & local data store
  usage         Read-only model spend & token report by day, task class, provider, and model
  serve         Start the local webhook server for voice and SMS provider events
  backup        Write a timestamped .tar.gz archive of client config, SQLite store, and audit log (never .env)
  restore       Restore a backup archive (refuses to overwrite a non-empty data dir without --force)
  demo          Run the Fort Smith HVAC shop demo with fake calendar, core engine, and channels pass
  help          Show this help message

Options:
  --days        Lookback window in days for 'aabook usage' (default: 7)
  --client      Client folder path for 'aabook usage' (default: ./client)
  --service     With 'aabook install', generate launchd plist (macOS) or systemd user unit (Linux)
  --force, -f   With 'aabook restore', allow overwriting a non-empty data directory
  --port, -p    Port for 'aabook serve' (default: 3000 or PORT env)
  --tick-ms     Follow-up dispatcher tick interval in ms for 'aabook serve' (default: 15000; 0 disables)
  --help, -h    Show help
  --version, -v Show version
`);
}

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  const command = args[0];

  try {
    switch (command) {
      case "install": {
        const installArgs = parseInstallArgs(args.slice(1));
        runInstall(installArgs);
        return 0;
      }
      case "setup": {
        await runSetup();
        return 0;
      }
      case "status": {
        const res = runStatus();
        return res.dbConnected ? 0 : 1;
      }
      case "usage": {
        const usageArgs = parseUsageArgs(args.slice(1));
        runUsage(usageArgs);
        return 0;
      }
      case "serve": {
        const serveArgs = parseServeArgs(args.slice(1));
        await startServe(serveArgs);
        return 0;
      }
      case "backup": {
        const backupArgs = parseBackupArgs(args.slice(1));
        runBackup(backupArgs);
        return 0;
      }
      case "restore": {
        const restoreArgs = parseRestoreArgs(args.slice(1));
        runRestore(restoreArgs);
        return 0;
      }
      case "demo": {
        const res = await runDemo(true);
        return res.success ? 0 : 1;
      }
      case "version":
      case "-v":
      case "--version": {
        console.log("aabook v0.1.0");
        return 0;
      }
      case "help":
      case "-h":
      case "--help":
      case undefined: {
        printHelp();
        return 0;
      }
      default: {
        console.error(`Unknown command: ${command}`);
        printHelp();
        return 1;
      }
    }
  } catch (err: unknown) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (import.meta.main) {
  main()
    .then((code) => {
      if (code !== 0) {
        process.exit(code);
      }
    })
    .catch((err) => {
      console.error("Fatal error:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}

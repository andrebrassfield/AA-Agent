import { runInstall } from "./cli/install.ts";
import { runSetup } from "./cli/setup.ts";
import { runStatus } from "./cli/status.ts";
import { parseServeArgs, startServe } from "./cli/serve.ts";
import { runDemo } from "./demo/runner.ts";

function printHelp() {
  console.log(`
AA Book: The installable front desk booking agent (CLI)

Usage:
  aabook <command> [options]

Commands:
  install       Check machine prerequisites and scaffold client and data directories
  setup         Interactive configuration wizard to create business/services/staff/persona/policies
  status        Check health and inspect current client configuration & local data store
  serve         Start the local webhook server for voice and SMS provider events
  demo          Run the Fort Smith HVAC shop demo with fake calendar, core engine, and channels pass
  help          Show this help message

Options:
  --port, -p    Port for 'aabook serve' (default: 3000 or PORT env)
  --help, -h    Show help
  --version, -v Show version
`);
}

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  const command = args[0];

  switch (command) {
    case "install": {
      runInstall();
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
    case "serve": {
      const serveArgs = parseServeArgs(args.slice(1));
      await startServe(serveArgs);
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
}

if (import.meta.main) {
  main().then((code) => {
    if (code !== 0) {
      process.exit(code);
    }
  }).catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

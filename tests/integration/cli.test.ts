import { describe, it, expect } from "bun:test";
import { runInstall } from "../../src/cli/install.ts";
import { runSetup } from "../../src/cli/setup.ts";
import { runStatus } from "../../src/cli/status.ts";
import { loadClientConfig } from "../../src/config/loader.ts";
import { main } from "../../src/index.ts";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("CLI Commands", () => {
  it("aabook install scaffolds directories and .env.example", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "aabook-install-test-"));
    const res = runInstall({ baseDir: tempDir });
    expect(res.success).toBe(true);
    expect(existsSync(res.clientDir)).toBe(true);
    expect(existsSync(res.dataDir)).toBe(true);
    expect(existsSync(join(tempDir, ".env.example"))).toBe(true);
    expect(existsSync(join(tempDir, ".env"))).toBe(true);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("aabook setup generates valid loadable client configs", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "aabook-setup-test-"));
    const clientDir = join(tempDir, "client");

    const created = await runSetup({
      clientDir,
      nonInteractiveDefaults: {
        business: {
          name: "River Valley AC",
          trade: "HVAC",
          timezone: "America/Chicago",
          hours: { mon: { open: "08:00", close: "17:00" } },
          phoneNumbers: { main: "+14795551111" },
          address: { street: "123 Towson Ave", city: "Fort Smith", state: "AR", zip: "72901" },
        },
      },
    });

    expect(created.business.name).toBe("River Valley AC");

    const loaded = loadClientConfig(clientDir);
    expect(loaded.success).toBe(true);
    expect(loaded.config?.business.name).toBe("River Valley AC");
    expect(loaded.config?.persona.aiDisclosureWording).toContain("automated AI assistant");

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("aabook status reports configuration state and sqlite metrics", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "aabook-status-test-"));
    const clientDir = join(tempDir, "client");
    const dataDir = join(tempDir, "data");

    const resBefore = runStatus({ clientDir, dataDir });
    expect(resBefore.clientLoaded).toBe(false);

    // Setup client dir
    runInstall({ baseDir: tempDir });
    runSetup({ clientDir, nonInteractiveDefaults: {} });

    const resAfter = runStatus({ clientDir, dataDir });
    expect(resAfter.clientLoaded).toBe(true);
    expect(resAfter.dbConnected).toBe(true);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("CLI entrypoint executes commands via main()", async () => {
    const helpCode = await main(["--help"]);
    expect(helpCode).toBe(0);

    const versionCode = await main(["--version"]);
    expect(versionCode).toBe(0);

    const statusCode = await main(["status"]);
    expect(statusCode).toBe(0);
  });
});

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { unpackTarGz } from "../../src/cli/backup.ts";
import { InstallError, runInstall } from "../../src/cli/install.ts";
import { runSetup } from "../../src/cli/setup.ts";
import { loadClientConfig } from "../../src/config/loader.ts";
import { DataStore } from "../../src/db/store.ts";
import { main } from "../../src/index.ts";

function withCapturedLogs<T>(fn: () => T): { result: T; logs: string } {
  const lines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    const result = fn();
    return { result, logs: lines.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

async function withCapturedLogsAsync<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string }> {
  const lines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    const result = await fn();
    return { result, logs: lines.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

describe("Packaging: One-Command Install, Service Units, & Backup/Restore", () => {
  it("fails with a plain-language message when Bun is missing or older than required", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "aabook-bun-check-"));
    try {
      expect(() => runInstall({ baseDir: tempDir, bunVersion: null })).toThrow(InstallError);
      try {
        runInstall({ baseDir: tempDir, bunVersion: null });
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain("requires Bun v1.1.0 or newer");
        expect(msg).toContain("https://bun.sh/install");
      }

      expect(() => runInstall({ baseDir: tempDir, bunVersion: "1.0.3" })).toThrow(InstallError);
      try {
        runInstall({ baseDir: tempDir, bunVersion: "1.0.3" });
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain("this machine has Bun v1.0.3");
        expect(msg).toContain("bun upgrade");
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("installs dependencies, scaffolds loadable client config without secrets, and is idempotent on second run", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "aabook-idempotent-"));
    const tempBinDir = mkdtempSync(join(tmpdir(), "aabook-bin-"));

    try {
      // Simulate a fresh clone with package.json, bun.lock, and bin/aabook.js
      writeFileSync(
        join(tempDir, "package.json"),
        JSON.stringify({ name: "aabook-test", dependencies: { "fake-pkg": "1.0.0" } }, null, 2),
        "utf-8"
      );
      writeFileSync(join(tempDir, "bun.lock"), "lock-v1\n", "utf-8");
      mkdirSync(join(tempDir, "bin"), { recursive: true });
      writeFileSync(join(tempDir, "bin", "aabook.js"), "#!/usr/bin/env bun\n", { mode: 0o644 });

      let depInstallCount = 0;
      const depInstaller = (cwd: string, frozen: boolean) => {
        expect(frozen).toBe(true);
        depInstallCount++;
        const pkgDir = join(cwd, "node_modules", "fake-pkg");
        mkdirSync(pkgDir, { recursive: true });
        writeFileSync(join(pkgDir, "package.json"), '{"name":"fake-pkg","version":"1.0.0"}', "utf-8");
        return { exitCode: 0, stderr: "" };
      };

      const first = withCapturedLogs(() =>
        runInstall({
          baseDir: tempDir,
          depInstaller,
          linkCli: true,
          cliBinDir: tempBinDir,
        })
      );

      expect(first.result.success).toBe(true);
      expect(first.result.changed).toBe(true);
      expect(first.result.alreadyInstalled).toBe(false);
      expect(depInstallCount).toBe(1);
      expect(first.logs).toContain("Installation complete!");
      expect(first.logs).toContain("Next steps:");

      // Verify CLI executable bit + symlink
      expect((statSync(join(tempDir, "bin", "aabook.js")).mode & 0o111) !== 0).toBe(true);
      expect(lstatSync(join(tempBinDir, "aabook")).isSymbolicLink()).toBe(true);

      // Verify scaffolded client config loads cleanly and templates contain zero secrets
      const loaded = loadClientConfig(first.result.clientDir);
      expect(loaded.success).toBe(true);
      const envExample = readFileSync(join(tempDir, ".env.example"), "utf-8");
      const envFile = readFileSync(join(tempDir, ".env"), "utf-8");
      expect(envExample).toContain("WEBHOOK_SECRET=\n");
      expect(envFile).toContain("WEBHOOK_SECRET=\n");

      // Simulate owner customizing business.json and .env, then re-running `aabook install`
      const bizPath = join(first.result.clientDir, "business.json");
      const customBiz = JSON.parse(readFileSync(bizPath, "utf-8"));
      customBiz.name = "Custom Razorback HVAC";
      writeFileSync(bizPath, JSON.stringify(customBiz, null, 2), "utf-8");
      writeFileSync(join(tempDir, ".env"), "WEBHOOK_SECRET=owner-custom-secret\n", "utf-8");

      const bizMtimeBefore = statSync(bizPath).mtimeMs;
      const envMtimeBefore = statSync(join(tempDir, ".env")).mtimeMs;

      const second = withCapturedLogs(() =>
        runInstall({
          baseDir: tempDir,
          depInstaller,
          linkCli: true,
          cliBinDir: tempBinDir,
        })
      );

      expect(second.result.alreadyInstalled).toBe(true);
      expect(second.result.changed).toBe(false);
      expect(second.result.actionsTaken).toHaveLength(0);
      expect(depInstallCount).toBe(1);
      expect(second.logs).toContain("Already installed — nothing changed.");
      expect(second.logs).toContain("Next steps:");

      // Confirm user edits and mtimes were completely untouched
      expect(JSON.parse(readFileSync(bizPath, "utf-8")).name).toBe("Custom Razorback HVAC");
      expect(readFileSync(join(tempDir, ".env"), "utf-8")).toBe("WEBHOOK_SECRET=owner-custom-secret\n");
      expect(statSync(bizPath).mtimeMs).toBe(bizMtimeBefore);
      expect(statSync(join(tempDir, ".env")).mtimeMs).toBe(envMtimeBefore);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(tempBinDir, { recursive: true, force: true });
    }
  });

  it("writes a valid macOS launchd plist named per client with start/stop commands and zero secrets", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "aabook-plist-"));
    const serviceDir = join(tempDir, "launchagents");
    try {
      runInstall({ baseDir: tempDir });
      await runSetup({
        clientDir: join(tempDir, "client"),
        nonInteractiveDefaults: {
          business: {
            name: "River Valley Plumbing & Drain",
            trade: "Plumbing",
            timezone: "America/Chicago",
            hours: { monday: { open: "08:00", close: "17:00" } },
            phoneNumbers: { main: "+14795552222" },
            address: { street: "400 Garrison Ave", city: "Fort Smith", state: "AR", zip: "72901" },
          },
        },
      });
      writeFileSync(join(tempDir, ".env"), "WEBHOOK_SECRET=super-secret-never-embed-darwin\n", "utf-8");

      const first = withCapturedLogs(() =>
        runInstall({
          baseDir: tempDir,
          service: true,
          platform: "darwin",
          serviceDir,
          bunExecutable: "/usr/local/bin/bun",
        })
      );

      expect(first.result.serviceUnitName).toBe(
        "com.arkansasautomated.aabook.river-valley-plumbing-and-drain"
      );
      expect(first.result.serviceFile).toBe(
        join(serviceDir, "com.arkansasautomated.aabook.river-valley-plumbing-and-drain.plist")
      );
      expect(existsSync(first.result.serviceFile!)).toBe(true);

      const plist = readFileSync(first.result.serviceFile!, "utf-8");
      expect(plist).toContain("<key>Label</key>");
      expect(plist).toContain(
        "<string>com.arkansasautomated.aabook.river-valley-plumbing-and-drain</string>"
      );
      expect(plist).toContain("<string>River Valley Plumbing &amp; Drain</string>".replace("<string>", "").replace("</string>", ""));
      expect(plist).toContain("<string>/usr/local/bin/bun</string>");
      expect(plist).toContain("<string>serve</string>");
      expect(plist).toContain("<key>KeepAlive</key>");
      expect(plist).not.toContain("super-secret-never-embed-darwin");

      expect(first.logs).toContain("launchctl bootstrap gui/$(id -u)");
      expect(first.logs).toContain("launchctl bootout gui/$(id -u)");

      if (existsSync("/usr/bin/plutil")) {
        const lint = spawnSync("/usr/bin/plutil", ["-lint", first.result.serviceFile!], {
          encoding: "utf-8",
        });
        expect(lint.status).toBe(0);
      }

      // Second run with --service is idempotent
      const second = runInstall({
        baseDir: tempDir,
        service: true,
        platform: "darwin",
        serviceDir,
        bunExecutable: "/usr/local/bin/bun",
      });
      expect(second.alreadyInstalled).toBe(true);
      expect(second.changed).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("writes a valid Linux systemd user unit named per client with start/stop commands and zero secrets", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "aabook-systemd-"));
    const serviceDir = join(tempDir, "systemd-user");
    try {
      runInstall({ baseDir: tempDir });
      await runSetup({
        clientDir: join(tempDir, "client"),
        nonInteractiveDefaults: {
          business: {
            name: "Ozark Comfort HVAC",
            trade: "HVAC",
            timezone: "America/Chicago",
            hours: { monday: { open: "08:00", close: "17:00" } },
            phoneNumbers: { main: "+14795553333" },
            address: { street: "500 Zero St", city: "Fort Smith", state: "AR", zip: "72903" },
          },
        },
      });
      writeFileSync(join(tempDir, ".env"), "WEBHOOK_SECRET=super-secret-never-embed-linux\n", "utf-8");

      const { result, logs } = withCapturedLogs(() =>
        runInstall({
          baseDir: tempDir,
          service: true,
          platform: "linux",
          serviceDir,
          bunExecutable: "/home/shop/.bun/bin/bun",
        })
      );

      expect(result.serviceUnitName).toBe("aabook-ozark-comfort-hvac.service");
      expect(result.serviceFile).toBe(join(serviceDir, "aabook-ozark-comfort-hvac.service"));
      expect(existsSync(result.serviceFile!)).toBe(true);

      const unit = readFileSync(result.serviceFile!, "utf-8");
      expect(unit).toContain("[Unit]");
      expect(unit).toContain("Description=AA Book Front Desk Agent (Ozark Comfort HVAC)");
      expect(unit).toContain("[Service]");
      expect(unit).toContain(`EnvironmentFile=-${join(tempDir, ".env")}`);
      expect(unit).toContain('ExecStart="/home/shop/.bun/bin/bun"');
      expect(unit).toContain(" serve --client-dir ");
      expect(unit).toContain("Restart=on-failure");
      expect(unit).toContain("[Install]");
      expect(unit).toContain("WantedBy=default.target");
      expect(unit).not.toContain("super-secret-never-embed-linux");

      expect(logs).toContain("systemctl --user daemon-reload && systemctl --user enable --now");
      expect(logs).toContain("systemctl --user stop aabook-ozark-comfort-hvac.service");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("backs up SQLite store (WAL-safe), client config, and audit log while strictly excluding .env secrets", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "aabook-backup-src-"));
    try {
      runInstall({ baseDir: tempDir });
      await runSetup({
        clientDir: join(tempDir, "client"),
        nonInteractiveDefaults: {
          business: {
            name: "Chaffee Electric Co",
            trade: "Electrical",
            timezone: "America/Chicago",
            hours: { monday: { open: "08:00", close: "17:00" } },
            phoneNumbers: { main: "+14795554444" },
            address: { street: "800 Roberts Blvd", city: "Fort Smith", state: "AR", zip: "72916" },
          },
        },
      });

      // Plant secrets in .env files at root, client/, and data/ to prove none ever enter the archive
      const secretMarker = "SECRET_API_TOKEN_DO_NOT_ARCHIVE_998877";
      writeFileSync(join(tempDir, ".env"), `WEBHOOK_SECRET=${secretMarker}\n`, "utf-8");
      writeFileSync(join(tempDir, "client", ".env"), `ROGUE_SECRET=${secretMarker}\n`, "utf-8");
      writeFileSync(join(tempDir, "data", ".env.production"), `PROD_SECRET=${secretMarker}\n`, "utf-8");

      // Keep DataStore open in WAL mode during backup to verify live online snapshot
      const liveStore = new DataStore(join(tempDir, "data", "aabook.sqlite"));
      try {
        const bookingId = liveStore.createBooking({
          customerName: "Marcus Reed",
          customerPhone: "+14795559090",
          serviceId: "panel-check",
          serviceName: "Breaker Panel Inspection",
          startTime: "2026-11-12T15:00:00.000Z",
          endTime: "2026-11-12T16:00:00.000Z",
          status: "confirmed",
        });
        liveStore.logAudit({
          action: "BOOKING_CREATED",
          entityType: "booking",
          entityId: bookingId,
          details: { source: "backup-test" },
        });

        const outDir = join(tempDir, "backups");
        const exitCode = await main([
          "backup",
          "--base-dir",
          tempDir,
          "--out-dir",
          outDir,
        ]);
        expect(exitCode).toBe(0);

        const archives = readdirSync(outDir).filter((f) => f.endsWith(".tar.gz"));
        expect(archives).toHaveLength(1);
        expect(archives[0]).toMatch(/^aabook-backup-chaffee-electric-co-\d{4}-\d{2}-\d{2}T.*Z\.tar\.gz$/);

        const archivePath = join(outDir, archives[0]!);
        const compressedBytes = new Uint8Array(readFileSync(archivePath));
        const rawTarText = Buffer.from(gunzipSync(compressedBytes)).toString("utf-8");
        expect(rawTarText).not.toContain(secretMarker);

        const unpacked = unpackTarGz(compressedBytes);
        const paths = unpacked.map((e) => e.path);
        expect(paths).toContain("client/business.json");
        expect(paths).toContain("client/services.json");
        expect(paths).toContain("data/aabook.sqlite");
        expect(paths).toContain("audit/audit-log.jsonl");
        expect(paths).toContain("manifest.json");
        expect(paths.some((p) => p.includes(".env"))).toBe(false);
        expect(paths.some((p) => p.endsWith("-wal") || p.endsWith("-shm"))).toBe(false);

        const auditEntry = unpacked.find((e) => e.path === "audit/audit-log.jsonl")!;
        const auditText = Buffer.from(auditEntry.data).toString("utf-8");
        expect(auditText).toContain("BOOKING_CREATED");
      } finally {
        liveStore.close();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("restores into an empty data dir, refuses non-empty overwrite without --force, and overwrites with --force", async () => {
    const srcDir = mkdtempSync(join(tmpdir(), "aabook-restore-src-"));
    const destDir = mkdtempSync(join(tmpdir(), "aabook-restore-dest-"));

    try {
      runInstall({ baseDir: srcDir });
      await runSetup({
        clientDir: join(srcDir, "client"),
        nonInteractiveDefaults: {
          business: {
            name: "crawlspace Pros AR",
            trade: "Waterproofing",
            timezone: "America/Chicago",
            hours: { monday: { open: "08:00", close: "17:00" } },
            phoneNumbers: { main: "+14795556666" },
            address: { street: "900 Jenny Lind Rd", city: "Fort Smith", state: "AR", zip: "72901" },
          },
        },
      });

      const store = new DataStore(join(srcDir, "data", "aabook.sqlite"));
      store.createBooking({
        customerName: "Hannah Cole",
        customerPhone: "+14795558181",
        serviceId: "vapor-barrier",
        serviceName: "Crawlspace Inspection",
        startTime: "2026-11-15T14:00:00.000Z",
        endTime: "2026-11-15T15:00:00.000Z",
        status: "confirmed",
      });
      store.logAudit({
        action: "SNAPSHOT_TEST",
        entityType: "system",
        entityId: "sys-1",
        details: { ok: true },
      });
      store.close();

      const archivePath = join(srcDir, "backups", "shop-snapshot.tar.gz");
      expect(await main(["backup", "--base-dir", srcDir, "--output", archivePath])).toBe(0);

      // 1. Restore into empty destination succeeds
      writeFileSync(join(destDir, ".env"), "WEBHOOK_SECRET=dest-local-secret\n", "utf-8");
      const restoreEmptyCode = await main(["restore", archivePath, "--base-dir", destDir]);
      expect(restoreEmptyCode).toBe(0);

      const restoredCfg = loadClientConfig(join(destDir, "client"));
      expect(restoredCfg.success).toBe(true);
      expect(restoredCfg.config?.business.name).toBe("crawlspace Pros AR");

      const restoredStore = new DataStore(join(destDir, "data", "aabook.sqlite"));
      expect(restoredStore.listBookings()).toHaveLength(1);
      expect(restoredStore.listBookings()[0]?.customerName).toBe("Hannah Cole");
      expect(restoredStore.listAuditLogs()).toHaveLength(1);

      // Mutate destination DB so it now has 2 bookings (and active WAL sidecars)
      restoredStore.createBooking({
        customerName: "Second Unsaved Customer",
        customerPhone: "+14795558282",
        serviceId: "vapor-barrier",
        serviceName: "Crawlspace Inspection",
        startTime: "2026-11-16T14:00:00.000Z",
        endTime: "2026-11-16T15:00:00.000Z",
        status: "confirmed",
      });
      restoredStore.close();

      // 2. Restore into non-empty dataDir WITHOUT --force must refuse with exit code 1 and preserve data
      const refused = await withCapturedLogsAsync(() =>
        main(["restore", archivePath, "--base-dir", destDir])
      );
      expect(refused.result).toBe(1);
      expect(refused.logs).toContain("Refusing to overwrite non-empty data directory");
      expect(refused.logs).toContain("--force");

      const checkUntouched = new DataStore(join(destDir, "data", "aabook.sqlite"));
      expect(checkUntouched.listBookings()).toHaveLength(2);
      checkUntouched.close();

      // 3. Restore WITH --force replaces data cleanly while preserving destination .env
      const forcedCode = await main(["restore", archivePath, "--base-dir", destDir, "--force"]);
      expect(forcedCode).toBe(0);

      const afterForce = new DataStore(join(destDir, "data", "aabook.sqlite"));
      expect(afterForce.listBookings()).toHaveLength(1);
      expect(afterForce.listBookings()[0]?.customerName).toBe("Hannah Cole");
      afterForce.close();

      expect(readFileSync(join(destDir, ".env"), "utf-8")).toBe("WEBHOOK_SECRET=dest-local-secret\n");
    } finally {
      rmSync(srcDir, { recursive: true, force: true });
      rmSync(destDir, { recursive: true, force: true });
    }
  });
});

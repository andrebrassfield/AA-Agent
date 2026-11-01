import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ClientConfig } from "../types/config.ts";

export interface ServiceUnitSpec {
  platform: "darwin" | "linux";
  clientSlug: string;
  unitName: string;
  filePath: string;
  content: string;
  startCommand: string;
  stopCommand: string;
}

export interface BuildServiceUnitOptions {
  baseDir: string;
  clientDir: string;
  dataDir: string;
  clientConfig: ClientConfig;
  platform?: NodeJS.Platform;
  serviceDir?: string;
  bunExecutable?: string;
  homeDir?: string;
}

export function slugifyClientName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "default";
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeSystemdArg(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function defaultServiceDir(platform: NodeJS.Platform, home: string = homedir()): string {
  if (platform === "darwin") {
    return join(home, "Library", "LaunchAgents");
  }
  if (platform === "linux") {
    return join(home, ".config", "systemd", "user");
  }
  throw new Error(
    `Service unit generation supports macOS (launchd) and Linux (systemd), received platform '${platform}'.`
  );
}

/**
 * Generates a macOS launchd plist or Linux systemd user unit for `aabook serve`.
 * Never reads or embeds secrets from .env or process.env; secrets stay in .env on disk.
 */
export function buildServiceUnit(options: BuildServiceUnitOptions): ServiceUnitSpec {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error(
      `AA Book background service setup supports macOS (launchd) and Linux (systemd). Current OS platform '${platform}' is not supported.`
    );
  }

  const absBaseDir = resolve(options.baseDir);
  const absClientDir = resolve(options.clientDir);
  const absDataDir = resolve(options.dataDir);
  const bunBin = resolve(options.bunExecutable || process.execPath);
  const entrypoint = join(absBaseDir, "bin", "aabook.js");
  const logsDir = join(absBaseDir, "logs");

  const businessName = options.clientConfig.business.name;
  const clientSlug = slugifyClientName(businessName);
  const targetDir = resolve(
    options.serviceDir || process.env.AABOOK_SERVICE_DIR || defaultServiceDir(platform, options.homeDir)
  );

  if (platform === "darwin") {
    const label = `com.arkansasautomated.aabook.${clientSlug}`;
    const filename = `${label}.plist`;
    const filePath = join(targetDir, filename);
    const stdoutLog = join(logsDir, `aabook-${clientSlug}.out.log`);
    const stderrLog = join(logsDir, `aabook-${clientSlug}.err.log`);

    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>Comment</key>
  <string>${escapeXml(`AA Book Front Desk Agent (${businessName})`)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(bunBin)}</string>
    <string>${escapeXml(entrypoint)}</string>
    <string>serve</string>
    <string>--client-dir</string>
    <string>${escapeXml(absClientDir)}</string>
    <string>--data-dir</string>
    <string>${escapeXml(absDataDir)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(absBaseDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutLog)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrLog)}</string>
</dict>
</plist>
`;

    return {
      platform: "darwin",
      clientSlug,
      unitName: label,
      filePath,
      content,
      startCommand: `launchctl bootstrap gui/$(id -u) "${filePath}"`,
      stopCommand: `launchctl bootout gui/$(id -u) "${filePath}"`,
    };
  }

  // Linux systemd user unit
  const unitName = `aabook-${clientSlug}.service`;
  const filePath = join(targetDir, unitName);
  const envFilePath = join(absBaseDir, ".env");
  const execStart = [
    escapeSystemdArg(bunBin),
    escapeSystemdArg(entrypoint),
    "serve",
    "--client-dir",
    escapeSystemdArg(absClientDir),
    "--data-dir",
    escapeSystemdArg(absDataDir),
  ].join(" ");

  const sanitizedDescription = businessName.replace(/[\r\n]+/g, " ").trim();
  const content = `[Unit]
Description=AA Book Front Desk Agent (${sanitizedDescription})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${escapeSystemdArg(absBaseDir)}
EnvironmentFile=-${envFilePath}
ExecStart=${execStart}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;

  const defaultLinuxDir = defaultServiceDir("linux", options.homeDir);
  const startCommand =
    targetDir === resolve(defaultLinuxDir)
      ? `systemctl --user daemon-reload && systemctl --user enable --now ${unitName}`
      : `systemctl --user daemon-reload && systemctl --user enable --now "${filePath}"`;
  const stopCommand = `systemctl --user stop ${unitName}`;

  return {
    platform: "linux",
    clientSlug,
    unitName,
    filePath,
    content,
    startCommand,
    stopCommand,
  };
}

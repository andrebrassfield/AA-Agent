import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { loadClientConfig } from "../config/loader.ts";
import { DataStore } from "../db/store.ts";
import { slugifyClientName } from "./service.ts";

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupError";
  }
}

export interface BackupOptions {
  baseDir?: string;
  clientDir?: string;
  dataDir?: string;
  outDir?: string;
  outputPath?: string;
  timestamp?: Date;
}

export interface BackupResult {
  success: boolean;
  archivePath: string;
  entries: string[];
  bookingCount: number;
  auditLogCount: number;
}

export interface RestoreOptions {
  archivePath: string;
  baseDir?: string;
  clientDir?: string;
  dataDir?: string;
  force?: boolean;
}

export interface RestoreResult {
  success: boolean;
  archivePath: string;
  restoredClientFiles: string[];
  restoredDataFiles: string[];
}

interface TarEntry {
  path: string;
  data: Uint8Array;
}

function isEnvSecretFile(fileNameOrPath: string): boolean {
  const parts = fileNameOrPath.split(/[\\/]/);
  return parts.some((segment) => /^\.env(\..+)?$/i.test(segment));
}

function isTransientSqliteSidecar(fileName: string): boolean {
  return /\.(sqlite|db)-(wal|shm|journal)$/i.test(fileName);
}

function validateSafeArchivePath(entryPath: string): string {
  const normalized = entryPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.includes("\0")
  ) {
    throw new BackupError(`Unsafe archive entry path rejected: '${entryPath}'`);
  }
  const segments = normalized.split("/");
  if (segments.some((seg) => seg === ".." || seg === "" || seg === ".")) {
    throw new BackupError(`Unsafe relative traversal in archive entry rejected: '${entryPath}'`);
  }
  if (isEnvSecretFile(normalized)) {
    throw new BackupError(`Refusing secret environment file in backup archive: '${entryPath}'`);
  }
  return segments.join("/");
}

function writeAsciiField(buf: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf-8");
  const count = Math.min(bytes.length, length);
  buf.set(bytes.subarray(0, count), offset);
}

function writeOctalField(buf: Uint8Array, offset: number, length: number, value: number): void {
  const octal = Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, "0");
  writeAsciiField(buf, offset, length - 1, octal);
  buf[offset + length - 1] = 0;
}

function splitUstarPath(safePath: string): { name: string; prefix: string } {
  if (Buffer.byteLength(safePath, "utf-8") <= 100) {
    return { name: safePath, prefix: "" };
  }
  const idx = safePath.lastIndexOf("/", 155);
  if (idx > 0) {
    const prefix = safePath.slice(0, idx);
    const name = safePath.slice(idx + 1);
    if (Buffer.byteLength(prefix, "utf-8") <= 155 && Buffer.byteLength(name, "utf-8") <= 100) {
      return { name, prefix };
    }
  }
  throw new BackupError(`Archive entry path exceeds POSIX USTAR length limit: '${safePath}'`);
}

export function packTarGz(entries: TarEntry[], mtimeSeconds: number = Math.floor(Date.now() / 1000)): Uint8Array {
  const chunks: Uint8Array[] = [];

  for (const entry of entries) {
    const safePath = validateSafeArchivePath(entry.path);
    const { name, prefix } = splitUstarPath(safePath);

    const header = new Uint8Array(512);
    writeAsciiField(header, 0, 100, name);
    writeOctalField(header, 100, 8, 0o644);
    writeOctalField(header, 108, 8, 0);
    writeOctalField(header, 116, 8, 0);
    writeOctalField(header, 124, 12, entry.data.byteLength);
    writeOctalField(header, 136, 12, mtimeSeconds);
    // Checksum field filled with spaces during sum calculation
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0); // normal file
    writeAsciiField(header, 257, 6, "ustar\0");
    writeAsciiField(header, 263, 2, "00");
    if (prefix) {
      writeAsciiField(header, 345, 155, prefix);
    }

    let sum = 0;
    for (let i = 0; i < 512; i++) {
      sum += header[i]!;
    }
    const chksumOctal = sum.toString(8).padStart(6, "0");
    writeAsciiField(header, 148, 6, chksumOctal);
    header[154] = 0;
    header[155] = 0x20;

    chunks.push(header);
    chunks.push(entry.data);

    const remainder = entry.data.byteLength % 512;
    if (remainder !== 0) {
      chunks.push(new Uint8Array(512 - remainder));
    }
  }

  // Two 512-byte zero blocks mark end-of-archive
  chunks.push(new Uint8Array(1024));

  const totalBytes = chunks.reduce((acc, c) => acc + c.byteLength, 0);
  const tarBytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    tarBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new Uint8Array(gzipSync(tarBytes));
}

function readNullTerminatedString(buf: Uint8Array, offset: number, length: number): string {
  let end = offset;
  const max = offset + length;
  while (end < max && buf[end] !== 0) {
    end++;
  }
  return Buffer.from(buf.subarray(offset, end)).toString("utf-8");
}

export function unpackTarGz(compressed: Uint8Array): TarEntry[] {
  let tarBytes: Uint8Array;
  try {
    tarBytes = new Uint8Array(gunzipSync(compressed));
  } catch (err) {
    throw new BackupError(
      `Invalid or corrupted backup archive (failed gzip decompression: ${err instanceof Error ? err.message : String(err)})`
    );
  }

  if (tarBytes.byteLength < 512 || tarBytes.byteLength % 512 !== 0) {
    throw new BackupError("Invalid backup archive: malformed tar block length.");
  }

  const entries: TarEntry[] = [];
  let offset = 0;

  while (offset + 512 <= tarBytes.byteLength) {
    const header = tarBytes.subarray(offset, offset + 512);
    offset += 512;

    let allZero = true;
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) {
      break;
    }

    const name = readNullTerminatedString(header, 0, 100);
    const prefix = readNullTerminatedString(header, 345, 155);
    const sizeOctal = readNullTerminatedString(header, 124, 12).trim();
    const size = sizeOctal ? parseInt(sizeOctal, 8) : 0;
    if (Number.isNaN(size) || size < 0 || offset + size > tarBytes.byteLength) {
      throw new BackupError("Invalid backup archive: corrupted tar entry header.");
    }

    const typeFlagChar = header[156] === 0 ? "0" : String.fromCharCode(header[156]!);
    const paddedDataSize = Math.ceil(size / 512) * 512;

    if (typeFlagChar === "0") {
      const fullPath = prefix ? `${prefix}/${name}` : name;
      const safePath = validateSafeArchivePath(fullPath);
      const data = tarBytes.slice(offset, offset + size);
      entries.push({ path: safePath, data });
    }

    offset += paddedDataSize;
  }

  return entries;
}

function collectDirectoryFiles(
  rootDir: string,
  archivePrefix: string,
  skipFilter?: (relPath: string, fileName: string) => boolean
): TarEntry[] {
  if (!existsSync(rootDir)) return [];
  const collected: TarEntry[] = [];

  const walk = (currentDir: string, relDir: string) => {
    const names = readdirSync(currentDir).sort();
    for (const name of names) {
      if (name === ".DS_Store") continue;
      const fullPath = join(currentDir, name);
      const relPath = relDir ? posix.join(relDir, name) : name;

      // Strictly exclude any .env or .env.* file at every directory level
      if (isEnvSecretFile(relPath)) {
        continue;
      }
      if (skipFilter && skipFilter(relPath, name)) {
        continue;
      }

      const st = statSync(fullPath);
      if (st.isDirectory()) {
        walk(fullPath, relPath);
      } else if (st.isFile()) {
        collected.push({
          path: posix.join(archivePrefix, relPath),
          data: new Uint8Array(readFileSync(fullPath)),
        });
      }
    }
  };

  walk(rootDir, "");
  return collected;
}

function formatBackupTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function parseBackupArgs(args: string[]): BackupOptions {
  const parsed: BackupOptions = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "--out-dir" || arg === "-o") && args[i + 1]) {
      parsed.outDir = args[++i];
    } else if (arg === "--output" && args[i + 1]) {
      parsed.outputPath = args[++i];
    } else if (arg === "--client-dir" && args[i + 1]) {
      parsed.clientDir = args[++i];
    } else if (arg === "--data-dir" && args[i + 1]) {
      parsed.dataDir = args[++i];
    } else if (arg === "--base-dir" && args[i + 1]) {
      parsed.baseDir = args[++i];
    }
  }
  return parsed;
}

export function parseRestoreArgs(args: string[]): RestoreOptions {
  let archivePath = "";
  let force = false;
  let clientDir: string | undefined;
  let dataDir: string | undefined;
  let baseDir: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--force" || arg === "-f") {
      force = true;
    } else if (arg === "--archive" && args[i + 1]) {
      archivePath = args[++i]!;
    } else if (arg === "--client-dir" && args[i + 1]) {
      clientDir = args[++i];
    } else if (arg === "--data-dir" && args[i + 1]) {
      dataDir = args[++i];
    } else if (arg === "--base-dir" && args[i + 1]) {
      baseDir = args[++i];
    } else if (!arg.startsWith("-") && !archivePath) {
      archivePath = arg;
    }
  }

  if (!archivePath) {
    throw new BackupError(
      "Missing backup archive path. Usage: aabook restore <path-to-backup.tar.gz> [--force]"
    );
  }

  return {
    archivePath,
    baseDir,
    clientDir,
    dataDir,
    force,
  };
}

export function runBackup(options: BackupOptions = {}): BackupResult {
  const baseDir = resolve(options.baseDir || process.cwd());
  const clientDir = resolve(options.clientDir || join(baseDir, "client"));
  const dataDir = resolve(options.dataDir || join(baseDir, "data"));
  const outDir = resolve(options.outDir || join(baseDir, "backups"));

  if (!existsSync(clientDir) && !existsSync(dataDir)) {
    throw new BackupError(
      `Nothing to back up: neither client config (${clientDir}) nor data dir (${dataDir}) exists. Run 'aabook install' first.`
    );
  }

  const loadedConfig = loadClientConfig(clientDir);
  const clientName = loadedConfig.config?.business.name || "client";
  const clientSlug = slugifyClientName(clientName);
  const now = options.timestamp ?? new Date();
  const ts = formatBackupTimestamp(now);

  const archivePath = resolve(
    options.outputPath || join(outDir, `aabook-backup-${clientSlug}-${ts}.tar.gz`)
  );

  const entries: TarEntry[] = [];

  // 1. Client config JSON files (strictly excluding any .env* files)
  const clientEntries = collectDirectoryFiles(clientDir, "client");
  entries.push(...clientEntries);

  // 2. Consistent SQLite snapshot (via VACUUM INTO) + audit log export + other non-secret data files
  let bookingCount = 0;
  let auditLogCount = 0;
  let auditJsonl = "";

  const liveDbPath = join(dataDir, "aabook.sqlite");
  if (existsSync(liveDbPath)) {
    const tempSnapDir = mkdtempSync(join(tmpdir(), "aabook-sqlite-snap-"));
    const snapDbPath = join(tempSnapDir, "aabook.sqlite");
    try {
      const escapedSnapPath = snapDbPath.replace(/'/g, "''");
      const srcDb = new Database(liveDbPath);
      try {
        srcDb.exec(`VACUUM INTO '${escapedSnapPath}'`);
      } finally {
        srcDb.close();
      }

      entries.push({
        path: "data/aabook.sqlite",
        data: new Uint8Array(readFileSync(snapDbPath)),
      });

      const snapStore = new DataStore(snapDbPath);
      try {
        bookingCount = snapStore.listBookings().length;
        const audits = snapStore.listAuditLogs();
        auditLogCount = audits.length;
        auditJsonl = audits.map((row) => JSON.stringify(row)).join("\n") + (audits.length > 0 ? "\n" : "");
      } finally {
        snapStore.close();
      }
    } finally {
      rmSync(tempSnapDir, { recursive: true, force: true });
    }
  }

  const extraDataEntries = collectDirectoryFiles(dataDir, "data", (_rel, fileName) => {
    return fileName === "aabook.sqlite" || isTransientSqliteSidecar(fileName);
  });
  entries.push(...extraDataEntries);

  // Export standalone audit log JSONL snapshot + backup manifest (zero secrets)
  entries.push({
    path: "audit/audit-log.jsonl",
    data: new Uint8Array(Buffer.from(auditJsonl, "utf-8")),
  });

  const manifest = {
    format: "aabook-backup-v1",
    createdAt: now.toISOString(),
    businessName: clientName,
    bookingCount,
    auditLogCount,
    secretsIncluded: false,
    files: entries.map((e) => e.path),
  };
  entries.push({
    path: "manifest.json",
    data: new Uint8Array(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf-8")),
  });

  mkdirSync(dirname(archivePath), { recursive: true });
  const archiveBytes = packTarGz(entries, Math.floor(now.getTime() / 1000));
  writeFileSync(archivePath, archiveBytes);

  console.log(`Backup created: ${archivePath}`);
  console.log(`- Client config files: ${clientEntries.length}`);
  console.log(`- Bookings archived:   ${bookingCount}`);
  console.log(`- Audit log entries:   ${auditLogCount}`);
  console.log(`- Secrets (.env):      excluded by design`);

  return {
    success: true,
    archivePath,
    entries: entries.map((e) => e.path),
    bookingCount,
    auditLogCount,
  };
}

function isDataDirNonEmpty(dataDir: string): boolean {
  if (!existsSync(dataDir)) return false;
  const items = readdirSync(dataDir).filter((name) => name !== ".DS_Store");
  return items.length > 0;
}

export function runRestore(options: RestoreOptions): RestoreResult {
  const archivePath = resolve(options.archivePath);
  if (!existsSync(archivePath)) {
    throw new BackupError(`Backup archive not found at: ${archivePath}`);
  }

  const baseDir = resolve(options.baseDir || process.cwd());
  const clientDir = resolve(options.clientDir || join(baseDir, "client"));
  const dataDir = resolve(options.dataDir || join(baseDir, "data"));

  if (isDataDirNonEmpty(dataDir) && !options.force) {
    throw new BackupError(
      `Refusing to overwrite non-empty data directory (${dataDir}). ` +
        `Pass '--force' ('aabook restore "${basename(archivePath)}" --force') if you want to replace existing data.`
    );
  }

  // Unpack & validate the entire archive in memory before modifying disk
  const compressed = new Uint8Array(readFileSync(archivePath));
  const entries = unpackTarGz(compressed);

  const hasRecognizedContent = entries.some(
    (e) => e.path === "manifest.json" || e.path.startsWith("client/") || e.path.startsWith("data/")
  );
  if (!hasRecognizedContent) {
    throw new BackupError(
      `Archive '${archivePath}' does not contain AA Book backup entries (client/ or data/).`
    );
  }

  if (options.force && existsSync(dataDir)) {
    for (const existing of readdirSync(dataDir)) {
      rmSync(join(dataDir, existing), { recursive: true, force: true });
    }
  }

  mkdirSync(clientDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const restoredClientFiles: string[] = [];
  const restoredDataFiles: string[] = [];

  for (const entry of entries) {
    if (entry.path.startsWith("client/")) {
      const rel = entry.path.slice("client/".length);
      if (!rel || isEnvSecretFile(rel)) continue;
      const dest = resolve(clientDir, rel);
      if (!dest.startsWith(clientDir + "/") && dest !== clientDir) {
        throw new BackupError(`Rejected unsafe client restore target: ${entry.path}`);
      }
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, entry.data);
      restoredClientFiles.push(rel);
    } else if (entry.path.startsWith("data/")) {
      const rel = entry.path.slice("data/".length);
      if (!rel || isEnvSecretFile(rel) || isTransientSqliteSidecar(rel)) continue;
      const dest = resolve(dataDir, rel);
      if (!dest.startsWith(dataDir + "/") && dest !== dataDir) {
        throw new BackupError(`Rejected unsafe data restore target: ${entry.path}`);
      }
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, entry.data);
      restoredDataFiles.push(rel);
    }
  }

  console.log(`Restored backup from: ${archivePath}`);
  console.log(`- Restored client config files: ${restoredClientFiles.length} -> ${clientDir}`);
  console.log(`- Restored data files:          ${restoredDataFiles.length} -> ${dataDir}`);
  console.log(`- Next step: run 'aabook status' to verify restored shop config and booking counts.`);

  return {
    success: true,
    archivePath,
    restoredClientFiles,
    restoredDataFiles,
  };
}

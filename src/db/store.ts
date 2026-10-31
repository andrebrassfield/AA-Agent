import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Booking, CallLog, AuditLogEntry, ModelUsageLog } from "../types/db.ts";

export class DataStore {
  private db: Database;

  constructor(dbPath: string = ":memory:") {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.initSchema();
  }

  private initSchema() {
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bookings (
        id TEXT PRIMARY KEY,
        customerName TEXT NOT NULL,
        customerPhone TEXT NOT NULL,
        serviceId TEXT NOT NULL,
        serviceName TEXT NOT NULL,
        staffId TEXT,
        startTime TEXT NOT NULL,
        endTime TEXT NOT NULL,
        status TEXT NOT NULL,
        notes TEXT,
        createdAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS call_logs (
        id TEXT PRIMARY KEY,
        callerPhone TEXT NOT NULL,
        direction TEXT NOT NULL,
        status TEXT NOT NULL,
        durationSeconds INTEGER NOT NULL,
        summary TEXT,
        timestamp TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        entityType TEXT NOT NULL,
        entityId TEXT NOT NULL,
        details TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS model_usage (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        taskClass TEXT NOT NULL,
        promptTokens INTEGER NOT NULL,
        completionTokens INTEGER NOT NULL,
        costUsd REAL NOT NULL,
        timestamp TEXT NOT NULL
      );
    `);
  }

  // --- Bookings ---
  createBooking(booking: Booking): void {
    const stmt = this.db.prepare(`
      INSERT INTO bookings (id, customerName, customerPhone, serviceId, serviceName, staffId, startTime, endTime, status, notes, createdAt)
      VALUES ($id, $customerName, $customerPhone, $serviceId, $serviceName, $staffId, $startTime, $endTime, $status, $notes, $createdAt)
    `);
    stmt.run({
      $id: booking.id,
      $customerName: booking.customerName,
      $customerPhone: booking.customerPhone,
      $serviceId: booking.serviceId,
      $serviceName: booking.serviceName,
      $staffId: booking.staffId || null,
      $startTime: booking.startTime,
      $endTime: booking.endTime,
      $status: booking.status,
      $notes: booking.notes || null,
      $createdAt: booking.createdAt,
    });
  }

  getBooking(id: string): Booking | null {
    const stmt = this.db.prepare("SELECT * FROM bookings WHERE id = ?");
    const row = stmt.get(id) as Booking | null;
    return row;
  }

  listBookings(): Booking[] {
    const stmt = this.db.prepare("SELECT * FROM bookings ORDER BY startTime ASC");
    return stmt.all() as Booking[];
  }

  updateBookingStatus(id: string, status: Booking["status"]): void {
    const stmt = this.db.prepare("UPDATE bookings SET status = ? WHERE id = ?");
    stmt.run(status, id);
  }

  // --- Call Logs ---
  logCall(log: CallLog): void {
    const stmt = this.db.prepare(`
      INSERT INTO call_logs (id, callerPhone, direction, status, durationSeconds, summary, timestamp)
      VALUES ($id, $callerPhone, $direction, $status, $durationSeconds, $summary, $timestamp)
    `);
    stmt.run({
      $id: log.id,
      $callerPhone: log.callerPhone,
      $direction: log.direction,
      $status: log.status,
      $durationSeconds: log.durationSeconds,
      $summary: log.summary || null,
      $timestamp: log.timestamp,
    });
  }

  listCallLogs(): CallLog[] {
    const stmt = this.db.prepare("SELECT * FROM call_logs ORDER BY timestamp DESC");
    return stmt.all() as CallLog[];
  }

  // --- Audit Logs ---
  logAudit(entry: AuditLogEntry): void {
    const stmt = this.db.prepare(`
      INSERT INTO audit_logs (id, action, entityType, entityId, details, timestamp)
      VALUES ($id, $action, $entityType, $entityId, $details, $timestamp)
    `);
    stmt.run({
      $id: entry.id,
      $action: entry.action,
      $entityType: entry.entityType,
      $entityId: entry.entityId,
      $details: JSON.stringify(entry.details),
      $timestamp: entry.timestamp,
    });
  }

  listAuditLogs(): (Omit<AuditLogEntry, "details"> & { details: Record<string, unknown> })[] {
    const stmt = this.db.prepare("SELECT * FROM audit_logs ORDER BY timestamp ASC");
    const rows = stmt.all() as { id: string; action: string; entityType: string; entityId: string; details: string; timestamp: string }[];
    return rows.map((r) => ({
      ...r,
      details: JSON.parse(r.details),
    }));
  }

  // --- Model Usage ---
  logModelUsage(usage: ModelUsageLog): void {
    const stmt = this.db.prepare(`
      INSERT INTO model_usage (id, provider, model, taskClass, promptTokens, completionTokens, costUsd, timestamp)
      VALUES ($id, $provider, $model, $taskClass, $promptTokens, $completionTokens, $costUsd, $timestamp)
    `);
    stmt.run({
      $id: usage.id,
      $provider: usage.provider,
      $model: usage.model,
      $taskClass: usage.taskClass,
      $promptTokens: usage.promptTokens,
      $completionTokens: usage.completionTokens,
      $costUsd: usage.costUsd,
      $timestamp: usage.timestamp,
    });
  }

  getTodaySpend(dayIsoDatePrefix: string): number {
    // dayIsoDatePrefix format: "YYYY-MM-DD"
    const stmt = this.db.prepare(`
      SELECT SUM(costUsd) as totalCost FROM model_usage WHERE timestamp LIKE ?
    `);
    const res = stmt.get(`${dayIsoDatePrefix}%`) as { totalCost: number | null };
    return res?.totalCost ?? 0;
  }

  listModelUsage(): ModelUsageLog[] {
    const stmt = this.db.prepare("SELECT * FROM model_usage ORDER BY timestamp DESC");
    return stmt.all() as ModelUsageLog[];
  }

  close(): void {
    this.db.close();
  }
}

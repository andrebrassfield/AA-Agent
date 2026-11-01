import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as crypto from "node:crypto";
import type {
  Booking,
  CallLog,
  AuditLogEntry,
  ModelUsageLog,
  EstimateStatus,
  ReviewStatus,
  ConversationMessage,
  ScheduledFollowUp,
} from "../types/db.ts";

/**
 * Single product-wide ID helper: millisecond timestamp plus cryptographic random suffix
 * so rapid tight-loop writes never collide on SQLite PRIMARY KEY constraints.
 */
export function generateId(prefix: string = "id"): string {
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  return `${prefix}-${Date.now()}-${rand}`;
}

export function normalizePhone(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  const numericOnly = digits.replace(/\D/g, "");
  if (numericOnly.length === 10) return `+1${numericOnly}`;
  if (numericOnly.length === 11 && numericOnly.startsWith("1")) return `+${numericOnly}`;
  return phone.trim();
}

export class DataStore {
  private db: Database;

  static generateId(prefix: string = "id"): string {
    return generateId(prefix);
  }

  generateId(prefix: string = "id"): string {
    return generateId(prefix);
  }

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
        providerCallId TEXT,
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

      CREATE TABLE IF NOT EXISTS estimates (
        id TEXT PRIMARY KEY,
        customerName TEXT NOT NULL,
        customerPhone TEXT NOT NULL,
        amount REAL NOT NULL,
        status TEXT NOT NULL,
        touchesSent TEXT NOT NULL,
        nextTouchAt TEXT,
        stopReason TEXT,
        createdAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY,
        bookingId TEXT,
        bookingLink TEXT NOT NULL,
        sendAt TEXT NOT NULL,
        status TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS missed_call_dedupe (
        id TEXT PRIMARY KEY,
        providerCallId TEXT NOT NULL UNIQUE,
        callerPhone TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversation_messages (
        id TEXT PRIMARY KEY,
        customerPhone TEXT NOT NULL,
        normalizedPhone TEXT NOT NULL,
        channel TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        providerCallId TEXT,
        timestamp TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_conv_norm_phone ON conversation_messages(normalizedPhone, timestamp);

      CREATE TABLE IF NOT EXISTS scheduled_followups (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        entityType TEXT NOT NULL,
        entityId TEXT NOT NULL,
        recipientPhone TEXT NOT NULL,
        message TEXT NOT NULL,
        scheduledFor TEXT NOT NULL,
        status TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );
    `);

    // Ensure backwards-compatible columns if opening an older SQLite database file
    this.ensureColumn("call_logs", "providerCallId", "TEXT");
    this.ensureColumn("reviews", "bookingId", "TEXT");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  // --- Bookings ---
  createBooking(booking: Omit<Booking, "id" | "createdAt"> & { id?: string; createdAt?: string }): string {
    const id = booking.id || this.generateId("bk");
    const createdAt = booking.createdAt || new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO bookings (id, customerName, customerPhone, serviceId, serviceName, staffId, startTime, endTime, status, notes, createdAt)
      VALUES ($id, $customerName, $customerPhone, $serviceId, $serviceName, $staffId, $startTime, $endTime, $status, $notes, $createdAt)
    `);
    stmt.run({
      $id: id,
      $customerName: booking.customerName,
      $customerPhone: booking.customerPhone,
      $serviceId: booking.serviceId,
      $serviceName: booking.serviceName,
      $staffId: booking.staffId || null,
      $startTime: booking.startTime,
      $endTime: booking.endTime,
      $status: booking.status,
      $notes: booking.notes || null,
      $createdAt: createdAt,
    });
    return id;
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

  // --- Call Logs & Missed-Call Dedupe ---
  logCall(log: Omit<CallLog, "id" | "timestamp"> & { id?: string; timestamp?: string }): string {
    const id = log.id || this.generateId("call");
    const timestamp = log.timestamp || new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO call_logs (id, callerPhone, direction, status, durationSeconds, summary, providerCallId, timestamp)
      VALUES ($id, $callerPhone, $direction, $status, $durationSeconds, $summary, $providerCallId, $timestamp)
    `);
    stmt.run({
      $id: id,
      $callerPhone: log.callerPhone,
      $direction: log.direction,
      $status: log.status,
      $durationSeconds: log.durationSeconds,
      $summary: log.summary || null,
      $providerCallId: log.providerCallId || null,
      $timestamp: timestamp,
    });
    return id;
  }

  listCallLogs(): CallLog[] {
    const stmt = this.db.prepare("SELECT * FROM call_logs ORDER BY timestamp DESC");
    return stmt.all() as CallLog[];
  }

  /**
   * Atomically claims a missed-call text-back for a given provider call ID.
   * Returns true if this is the first time seeing providerCallId, false on any duplicate.
   */
  claimMissedCallTextBack(providerCallId: string, callerPhone: string): boolean {
    const id = this.generateId("mcd");
    const createdAt = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO missed_call_dedupe (id, providerCallId, callerPhone, createdAt)
      VALUES ($id, $providerCallId, $callerPhone, $createdAt)
    `);
    const res = stmt.run({
      $id: id,
      $providerCallId: providerCallId,
      $callerPhone: callerPhone,
      $createdAt: createdAt,
    });
    return res.changes > 0;
  }

  // --- Audit Logs ---
  logAudit(entry: Omit<AuditLogEntry, "id" | "timestamp"> & { id?: string; timestamp?: string }): string {
    const id = entry.id || this.generateId("aud");
    const timestamp = entry.timestamp || new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO audit_logs (id, action, entityType, entityId, details, timestamp)
      VALUES ($id, $action, $entityType, $entityId, $details, $timestamp)
    `);
    stmt.run({
      $id: id,
      $action: entry.action,
      $entityType: entry.entityType,
      $entityId: entry.entityId,
      $details: JSON.stringify(entry.details),
      $timestamp: timestamp,
    });
    return id;
  }

  listAuditLogs(): (Omit<AuditLogEntry, "details"> & { details: Record<string, unknown> })[] {
    const stmt = this.db.prepare("SELECT * FROM audit_logs ORDER BY timestamp ASC, rowid ASC");
    const rows = stmt.all() as { id: string; action: string; entityType: string; entityId: string; details: string; timestamp: string }[];
    return rows.map((r) => ({
      ...r,
      details: JSON.parse(r.details),
    }));
  }

  // --- Model Usage ---
  logModelUsage(usage: Omit<ModelUsageLog, "id" | "timestamp"> & { id?: string; timestamp?: string }): string {
    const id = usage.id || this.generateId("mu");
    const timestamp = usage.timestamp || new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO model_usage (id, provider, model, taskClass, promptTokens, completionTokens, costUsd, timestamp)
      VALUES ($id, $provider, $model, $taskClass, $promptTokens, $completionTokens, $costUsd, $timestamp)
    `);
    stmt.run({
      $id: id,
      $provider: usage.provider,
      $model: usage.model,
      $taskClass: usage.taskClass,
      $promptTokens: usage.promptTokens,
      $completionTokens: usage.completionTokens,
      $costUsd: usage.costUsd,
      $timestamp: timestamp,
    });
    return id;
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

  // --- Estimates ---
  createEstimate(estimate: Omit<EstimateStatus, "id" | "createdAt"> & { id?: string; createdAt?: string }): string {
    const id = estimate.id || this.generateId("est");
    const createdAt = estimate.createdAt || new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO estimates (id, customerName, customerPhone, amount, status, touchesSent, nextTouchAt, stopReason, createdAt)
      VALUES ($id, $customerName, $customerPhone, $amount, $status, $touchesSent, $nextTouchAt, $stopReason, $createdAt)
    `);
    stmt.run({
      $id: id,
      $customerName: estimate.customerName,
      $customerPhone: estimate.customerPhone,
      $amount: estimate.amount,
      $status: estimate.status,
      $touchesSent: estimate.touchesSent,
      $nextTouchAt: estimate.nextTouchAt || null,
      $stopReason: estimate.stopReason || null,
      $createdAt: createdAt,
    });
    return id;
  }

  getEstimate(id: string): EstimateStatus | null {
    const stmt = this.db.prepare("SELECT * FROM estimates WHERE id = ?");
    return (stmt.get(id) as EstimateStatus) || null;
  }

  listOpenEstimatesByPhone(customerPhone: string): EstimateStatus[] {
    const normTarget = normalizePhone(customerPhone);
    const stmt = this.db.prepare("SELECT * FROM estimates WHERE status = 'open'");
    const openEstimates = stmt.all() as EstimateStatus[];
    return openEstimates.filter((est) => normalizePhone(est.customerPhone) === normTarget);
  }

  updateEstimate(estimate: EstimateStatus): void {
    const stmt = this.db.prepare(`
      UPDATE estimates SET status = $status, touchesSent = $touchesSent, nextTouchAt = $nextTouchAt, stopReason = $stopReason
      WHERE id = $id
    `);
    stmt.run({
      $id: estimate.id,
      $status: estimate.status,
      $touchesSent: estimate.touchesSent,
      $nextTouchAt: estimate.nextTouchAt || null,
      $stopReason: estimate.stopReason || null,
    });
  }

  // --- Reviews ---
  createReview(review: Omit<ReviewStatus, "id" | "createdAt"> & { id?: string; createdAt?: string }): string {
    const id = review.id || this.generateId("rev");
    const createdAt = review.createdAt || new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO reviews (id, bookingId, bookingLink, sendAt, status, createdAt)
      VALUES ($id, $bookingId, $bookingLink, $sendAt, $status, $createdAt)
    `);
    stmt.run({
      $id: id,
      $bookingId: review.bookingId || id,
      $bookingLink: review.bookingLink,
      $sendAt: review.sendAt,
      $status: review.status,
      $createdAt: createdAt,
    });
    return id;
  }

  getReview(idOrBookingId: string): ReviewStatus | null {
    const stmt = this.db.prepare("SELECT * FROM reviews WHERE id = ? OR bookingId = ?");
    return (stmt.get(idOrBookingId, idOrBookingId) as ReviewStatus) || null;
  }

  updateReviewStatus(idOrBookingId: string, status: ReviewStatus["status"]): void {
    const stmt = this.db.prepare("UPDATE reviews SET status = ? WHERE id = ? OR bookingId = ?");
    stmt.run(status, idOrBookingId, idOrBookingId);
  }

  // --- Shared Voice + SMS Conversation History ---
  appendConversationMessage(
    msg: Omit<ConversationMessage, "id" | "timestamp"> & { id?: string; timestamp?: string }
  ): string {
    const id = msg.id || this.generateId("msg");
    const timestamp = msg.timestamp || new Date().toISOString();
    const normalizedPhone = normalizePhone(msg.customerPhone);
    const stmt = this.db.prepare(`
      INSERT INTO conversation_messages (id, customerPhone, normalizedPhone, channel, role, content, providerCallId, timestamp)
      VALUES ($id, $customerPhone, $normalizedPhone, $channel, $role, $content, $providerCallId, $timestamp)
    `);
    stmt.run({
      $id: id,
      $customerPhone: msg.customerPhone,
      $normalizedPhone: normalizedPhone,
      $channel: msg.channel,
      $role: msg.role,
      $content: msg.content,
      $providerCallId: msg.providerCallId || null,
      $timestamp: timestamp,
    });
    return id;
  }

  getConversationHistory(customerPhone: string): ConversationMessage[] {
    const normalizedPhone = normalizePhone(customerPhone);
    const stmt = this.db.prepare(`
      SELECT id, customerPhone, channel, role, content, providerCallId, timestamp
      FROM conversation_messages
      WHERE normalizedPhone = ?
      ORDER BY timestamp ASC, rowid ASC
    `);
    return stmt.all(normalizedPhone) as ConversationMessage[];
  }

  // --- Scheduled Follow-Up State ---
  scheduleFollowUp(
    followUp: Omit<ScheduledFollowUp, "id" | "createdAt"> & { id?: string; createdAt?: string }
  ): string {
    const id = followUp.id || this.generateId("fup");
    const createdAt = followUp.createdAt || new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO scheduled_followups (id, type, entityType, entityId, recipientPhone, message, scheduledFor, status, createdAt)
      VALUES ($id, $type, $entityType, $entityId, $recipientPhone, $message, $scheduledFor, $status, $createdAt)
    `);
    stmt.run({
      $id: id,
      $type: followUp.type,
      $entityType: followUp.entityType,
      $entityId: followUp.entityId,
      $recipientPhone: followUp.recipientPhone,
      $message: followUp.message,
      $scheduledFor: followUp.scheduledFor,
      $status: followUp.status,
      $createdAt: createdAt,
    });
    return id;
  }

  listFollowUps(entityId?: string): ScheduledFollowUp[] {
    if (entityId) {
      const stmt = this.db.prepare("SELECT * FROM scheduled_followups WHERE entityId = ? ORDER BY scheduledFor ASC, rowid ASC");
      return stmt.all(entityId) as ScheduledFollowUp[];
    }
    const stmt = this.db.prepare("SELECT * FROM scheduled_followups ORDER BY scheduledFor ASC, rowid ASC");
    return stmt.all() as ScheduledFollowUp[];
  }

  cancelFollowUpsForEntity(entityType: string, entityId: string): number {
    const stmt = this.db.prepare(`
      UPDATE scheduled_followups SET status = 'cancelled'
      WHERE entityType = ? AND entityId = ? AND status = 'pending'
    `);
    const res = stmt.run(entityType, entityId);
    return res.changes;
  }

  close(): void {
    this.db.close();
  }
}

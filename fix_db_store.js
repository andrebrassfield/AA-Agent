import fs from 'fs';

let content = fs.readFileSync('src/db/store.ts', 'utf-8');

// Add imports
content = content.replace(
  `import type { Booking, CallLog, AuditLogEntry, ModelUsageLog } from "../types/db.ts";`,
  `import type { Booking, CallLog, AuditLogEntry, ModelUsageLog, EstimateStatus, ReviewStatus } from "../types/db.ts";`
);

// Add tables to initSchema
content = content.replace(
  `      CREATE TABLE IF NOT EXISTS model_usage (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        taskClass TEXT NOT NULL,
        promptTokens INTEGER NOT NULL,
        completionTokens INTEGER NOT NULL,
        costUsd REAL NOT NULL,
        timestamp TEXT NOT NULL
      );
    `);`,
  `      CREATE TABLE IF NOT EXISTS model_usage (
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
        bookingLink TEXT NOT NULL,
        sendAt TEXT NOT NULL,
        status TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );
    `);`
);

// Add Estimate & Review methods
const dbMethods = `
  // --- Estimates ---
  createEstimate(estimate: EstimateStatus): void {
    const stmt = this.db.prepare(\`
      INSERT INTO estimates (id, customerName, customerPhone, amount, status, touchesSent, nextTouchAt, stopReason, createdAt)
      VALUES ($id, $customerName, $customerPhone, $amount, $status, $touchesSent, $nextTouchAt, $stopReason, $createdAt)
    \`);
    stmt.run({
      $id: estimate.id,
      $customerName: estimate.customerName,
      $customerPhone: estimate.customerPhone,
      $amount: estimate.amount,
      $status: estimate.status,
      $touchesSent: estimate.touchesSent,
      $nextTouchAt: estimate.nextTouchAt || null,
      $stopReason: estimate.stopReason || null,
      $createdAt: estimate.createdAt
    });
  }

  getEstimate(id: string): EstimateStatus | null {
    const stmt = this.db.prepare("SELECT * FROM estimates WHERE id = ?");
    return (stmt.get(id) as EstimateStatus) || null;
  }

  updateEstimate(estimate: EstimateStatus): void {
    const stmt = this.db.prepare(\`
      UPDATE estimates SET status = $status, touchesSent = $touchesSent, nextTouchAt = $nextTouchAt, stopReason = $stopReason
      WHERE id = $id
    \`);
    stmt.run({
      $id: estimate.id,
      $status: estimate.status,
      $touchesSent: estimate.touchesSent,
      $nextTouchAt: estimate.nextTouchAt || null,
      $stopReason: estimate.stopReason || null
    });
  }

  // --- Reviews ---
  createReview(review: ReviewStatus): void {
    const stmt = this.db.prepare(\`
      INSERT INTO reviews (id, bookingLink, sendAt, status, createdAt)
      VALUES ($id, $bookingLink, $sendAt, $status, $createdAt)
    \`);
    stmt.run({
      $id: review.id,
      $bookingLink: review.bookingLink,
      $sendAt: review.sendAt,
      $status: review.status,
      $createdAt: review.createdAt
    });
  }

  getReview(id: string): ReviewStatus | null {
    const stmt = this.db.prepare("SELECT * FROM reviews WHERE id = ?");
    return (stmt.get(id) as ReviewStatus) || null;
  }

  updateReviewStatus(id: string, status: ReviewStatus["status"]): void {
    const stmt = this.db.prepare("UPDATE reviews SET status = ? WHERE id = ?");
    stmt.run(status, id);
  }
`;

content = content.replace(
  `  close(): void {`,
  dbMethods + `\n  close(): void {`
);

fs.writeFileSync('src/db/store.ts', content);

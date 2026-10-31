import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadClientConfig } from "../config/loader.ts";
import { DataStore } from "../db/store.ts";

export interface StatusOptions {
  clientDir?: string;
  dataDir?: string;
}

export function runStatus(options: StatusOptions = {}): {
  clientLoaded: boolean;
  dbConnected: boolean;
  summary: Record<string, unknown>;
} {
  const baseDir = process.cwd();
  const clientDir = options.clientDir || join(baseDir, "client");
  const dataDir = options.dataDir || join(baseDir, "data");
  const dbPath = join(dataDir, "aabook.sqlite");

  console.log("===============================================================");
  console.log("                      AA BOOK CLI STATUS                       ");
  console.log("===============================================================");
  console.log(`Working Directory: ${baseDir}`);
  console.log(`Client Config Dir: ${clientDir}`);
  console.log(`Local Data Dir:    ${dataDir}`);
  console.log("---------------------------------------------------------------");

  // Check Client Config
  const loadResult = loadClientConfig(clientDir);
  let clientLoaded = false;
  if (!loadResult.success) {
    console.log("❌ Client Configuration: INVALID OR INCOMPLETE");
    loadResult.errors.forEach((err) => {
      console.log(`   - ${err.file}: ${err.issues.join("; ")}`);
    });
  } else {
    clientLoaded = true;
    const cfg = loadResult.config!;
    console.log("✅ Client Configuration: OK");
    console.log(`   - Business:  ${cfg.business.name} (${cfg.business.trade})`);
    console.log(`   - Phone:     ${cfg.business.phoneNumbers.main}`);
    console.log(`   - Services:  ${cfg.services.services.length} registered`);
    console.log(`   - Staff:     ${cfg.staff.staff.length} staff member(s)`);
    console.log(`   - Voice:     ${cfg.persona.voiceChoice} (Tone: ${cfg.persona.tone})`);
  }

  console.log("---------------------------------------------------------------");
  // Check Database
  let dbConnected = false;
  let bookingCount = 0;
  let callLogCount = 0;
  let auditCount = 0;
  let todaySpend = 0;

  try {
    const store = new DataStore(existsSync(dbPath) ? dbPath : ":memory:");
    bookingCount = store.listBookings().length;
    callLogCount = store.listCallLogs().length;
    auditCount = store.listAuditLogs().length;
    todaySpend = store.getTodaySpend(new Date().toISOString().substring(0, 10));
    dbConnected = true;
    store.close();
    console.log(`✅ Local Data Store (SQLite): OK (${existsSync(dbPath) ? dbPath : "in-memory initialization test"})`);
    console.log(`   - Bookings recorded:   ${bookingCount}`);
    console.log(`   - Call logs recorded:  ${callLogCount}`);
    console.log(`   - Audit log entries:   ${auditCount}`);
    console.log(`   - Today's model spend: $${todaySpend.toFixed(4)}`);
  } catch (err: unknown) {
    console.log(`❌ Local Data Store: ERROR (${err instanceof Error ? err.message : String(err)})`);
  }

  console.log("===============================================================");

  return {
    clientLoaded,
    dbConnected,
    summary: {
      clientDir,
      dataDir,
      clientLoaded,
      dbConnected,
      bookingCount,
      callLogCount,
      auditCount,
      todaySpend,
    },
  };
}

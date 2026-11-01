import { expect, test, describe } from "bun:test";
import { webhookHandler } from "../../src/server/webhook.ts";
import { DataStore } from "../../src/db/store.ts";
import type { ServerConfig } from "../../src/server/server.ts";
import type { EngineAdapter } from "../../src/types/engine.ts";
import { FORT_SMITH_HVAC_CONFIG } from "../../src/demo/shop_data.ts";

describe("Webhook tests", () => {
    const mockEngine: EngineAdapter = {
        name: "mock",
        processTurn: async (input) => ({ reply: "mock reply" }),
    };

    test("Rejects request without auth header", async () => {
        const store = new DataStore(":memory:");
        const config: ServerConfig = { port: 8080, webhookSecret: "secret", store, engine: mockEngine, clientConfig: FORT_SMITH_HVAC_CONFIG };
        const req = new Request("http://localhost/webhooks/voice", { method: "POST" });
        const res = await webhookHandler(req, config);
        expect(res.status).toBe(401);
    });

    test("Rejects request with bad auth header", async () => {
        const store = new DataStore(":memory:");
        const config: ServerConfig = { port: 8080, webhookSecret: "secret", store, engine: mockEngine, clientConfig: FORT_SMITH_HVAC_CONFIG };
        const req = new Request("http://localhost/webhooks/voice", { method: "POST", headers: { Authorization: "Bearer badsecret" } });
        const res = await webhookHandler(req, config);
        expect(res.status).toBe(401);
    });

    test("Missed call triggers exactly one text-back", async () => {
        const store = new DataStore(":memory:");
        const config: ServerConfig = { port: 8080, webhookSecret: "secret", store, engine: mockEngine, clientConfig: FORT_SMITH_HVAC_CONFIG };
        const req = new Request("http://localhost/webhooks/voice", {
            method: "POST",
            headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
            body: JSON.stringify({ event: "call_ended", call: { status: "missed", from: "+1234567890", call_id: "c1" } })
        });
        const res = await webhookHandler(req, config);
        expect(res.status).toBe(200);

        const logs = store.listAuditLogs().filter(l => l.action === "MISSED_CALL_TEXT_BACK_SENT");
        expect(logs.length).toBe(1);

        // Dedupe
        const req2 = new Request("http://localhost/webhooks/voice", {
            method: "POST",
            headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
            body: JSON.stringify({ event: "call_ended", call: { status: "missed", from: "+1234567890", call_id: "c1" } })
        });
        await webhookHandler(req2, config);

        const logsAfter = store.listAuditLogs().filter(l => l.action === "MISSED_CALL_TEXT_BACK_SENT");
        expect(logsAfter.length).toBe(1); // Still 1

        const dedupeLogs = store.listAuditLogs().filter(l => l.action === "MISSED_CALL_TEXT_BACK_DEDUPE");
        expect(dedupeLogs.length).toBe(1);
    });

    test("Voice call books through tool endpoints", async () => {
        const store = new DataStore(":memory:");
        const config: ServerConfig = { port: 8080, webhookSecret: "secret", store, engine: mockEngine, clientConfig: FORT_SMITH_HVAC_CONFIG };
        const req = new Request("http://localhost/webhooks/voice", {
            method: "POST",
            headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
            body: JSON.stringify({
                event: "tool_call",
                tool: {
                    name: "manageBooking",
                    args: {
                        action: "create",
                        input: {
                            customerName: "Jane Doe",
                            customerPhone: "+15551234567",
                            serviceId: "ac-tuneup",
                            requestedStartTime: (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() + ((1 + 7 - d.getUTCDay()) % 7 || 7)); d.setUTCHours(14, 0, 0, 0); return d.toISOString(); })() // Valid future time
                        }
                    }
                }
            })
        });
        const res = await webhookHandler(req, config);
        expect(res.status).toBe(200);
        const data = await res.json() as any;
        expect(data.success).toBe(true);
        expect(data.result.booking).toBeDefined();
    });

    test("Inbound SMS reply stops pending estimate touches", async () => {
        const store = new DataStore(":memory:");
        const config: ServerConfig = { port: 8080, webhookSecret: "secret", store, engine: mockEngine, clientConfig: FORT_SMITH_HVAC_CONFIG };

        store.createEstimate({
            id: "est-1",
            customerName: "Test",
            customerPhone: "+15559998888",
            amount: 1000,
            status: "open",
            touchesSent: "[]",
            createdAt: new Date().toISOString()
        });

        const req = new Request("http://localhost/webhooks/sms", {
            method: "POST",
            headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
            body: JSON.stringify({ from: "+15559998888", body: "I approve this estimate" })
        });

        const res = await webhookHandler(req, config);
        expect(res.status).toBe(200);

        const updatedEstimate = store.getEstimate("est-1");
        expect(updatedEstimate?.status).toBe("replied");

        const stopAudit = store.listAuditLogs().filter(l => l.action === "ESTIMATE_TOUCH_STOPPED");
        expect(stopAudit.length).toBeGreaterThan(0);
    });
});

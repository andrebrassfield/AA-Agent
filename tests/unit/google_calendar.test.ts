import { describe, it, expect, mock } from "bun:test";
import { GoogleCalendarAdapter } from "../../src/calendar/calendar.ts";

describe("GoogleCalendarAdapter", () => {
  // Generate a real RS256 key pair to test JWT signing locally without external calls
  it("authenticates and creates an event against a fake HTTP layer", async () => {
    const keyPair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"]
    );

    const privateKeyBuffer = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
    const privateKeyB64 = Buffer.from(privateKeyBuffer).toString("base64");
    const pemKey = `-----BEGIN PRIVATE KEY-----\n${privateKeyB64.match(/.{1,64}/g)?.join("\n")}\n-----END PRIVATE KEY-----\n`;

    // Mock fetch to simulate Google APIs
    let authCalled = false;
    let createCalled = false;

    const fakeFetch = async (url: string | Request | URL, options?: RequestInit): Promise<Response> => {
      const urlStr = url.toString();

      if (urlStr === "https://oauth2.googleapis.com/token") {
        authCalled = true;
        // Verify it was a POST with assertion
        expect(options?.method).toBe("POST");
        expect(options?.body?.toString()).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");
        return new Response(JSON.stringify({ access_token: "fake-access-token", expires_in: 3600 }), { status: 200 });
      }

      if (urlStr.includes("/events")) {
        createCalled = true;
        // Verify auth header
        expect((options?.headers as any)?.Authorization).toBe("Bearer fake-access-token");
        return new Response(JSON.stringify({ id: "real-gc-id-123" }), { status: 200 });
      }

      return new Response("Not Found", { status: 404 });
    };

    const adapter = new GoogleCalendarAdapter("my-cal", "test@test.com", pemKey, fakeFetch as any);

    const ev = await adapter.createEvent({
      id: "ignored",
      title: "Test Event",
      startTime: "2026-11-01T10:00:00.000Z",
      endTime: "2026-11-01T11:00:00.000Z",
    });

    expect(authCalled).toBe(true);
    expect(createCalled).toBe(true);
    expect(ev.id).toBe("real-gc-id-123"); // Proves it extracted ID from fake fetch response
  });
});

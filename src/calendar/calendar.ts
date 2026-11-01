import { generateId } from "../db/store.ts";

export interface CalendarEvent {
  id: string;
  title: string;
  startTime: string;
  endTime: string;
  attendees?: string[];
  description?: string;
}

export interface CalendarAdapter {
  name: string;
  checkAvailability(startTime: string, endTime: string): Promise<boolean>;
  createEvent(event: Omit<CalendarEvent, "id"> & { id?: string }): Promise<CalendarEvent>;
  listEvents(start: string, end: string): Promise<CalendarEvent[]>;
  updateEvent(id: string, updates: Partial<CalendarEvent>): Promise<CalendarEvent>;
  deleteEvent(id: string): Promise<void>;
}

export class FakeCalendar implements CalendarAdapter {
  name = "fake-calendar";
  private events: CalendarEvent[] = [];

  constructor(initialEvents: CalendarEvent[] = []) {
    this.events = [...initialEvents];
  }

  async checkAvailability(startTime: string, endTime: string): Promise<boolean> {
    const start = new Date(startTime).getTime();
    const end = new Date(endTime).getTime();

    const conflict = this.events.some((ev) => {
      const evStart = new Date(ev.startTime).getTime();
      const evEnd = new Date(ev.endTime).getTime();
      return (start < evEnd && end > evStart);
    });

    return !conflict;
  }

  async createEvent(event: Omit<CalendarEvent, "id"> & { id?: string }): Promise<CalendarEvent> {
    const available = await this.checkAvailability(event.startTime, event.endTime);
    if (!available) {
      throw new Error(`Calendar slot from ${event.startTime} to ${event.endTime} is not available.`);
    }
    const created: CalendarEvent = {
      ...event,
      id: event.id || generateId("ev"),
    };
    this.events.push(created);
    return created;
  }

  async updateEvent(id: string, updates: Partial<CalendarEvent>): Promise<CalendarEvent> {
    const idx = this.events.findIndex(e => e.id === id);
    if (idx === -1) throw new Error(`Event ${id} not found`);

    // Check conflicts if times changed
    if (updates.startTime || updates.endTime) {
      const start = updates.startTime || this.events[idx].startTime;
      const end = updates.endTime || this.events[idx].endTime;

      const conflict = this.events.some((ev) => {
        if (ev.id === id) return false;
        const evStart = new Date(ev.startTime).getTime();
        const evEnd = new Date(ev.endTime).getTime();
        return (new Date(start).getTime() < evEnd && new Date(end).getTime() > evStart);
      });
      if (conflict) throw new Error(`Calendar slot is not available.`);
    }

    this.events[idx] = { ...this.events[idx], ...updates };
    return this.events[idx];
  }

  async deleteEvent(id: string): Promise<void> {
    const idx = this.events.findIndex(e => e.id === id);
    if (idx !== -1) {
      this.events.splice(idx, 1);
    }
  }

  async listEvents(start: string, end: string): Promise<CalendarEvent[]> {
    const s = new Date(start).getTime();
    const e = new Date(end).getTime();
    return this.events.filter((ev) => {
      const evStart = new Date(ev.startTime).getTime();
      return evStart >= s && evStart <= e;
    });
  }
}


export class GoogleCalendarAdapter implements CalendarAdapter {
  name = "google-calendar";
  private calendarId: string;
  private clientEmail: string;
  private privateKey: string;
  private token: string | null = null;
  private tokenExp: number = 0;
  // Allows testing against fake HTTP layer
  private fetchImpl: typeof fetch;

  constructor(calendarId: string, clientEmail: string, privateKey: string, fetchImpl: typeof fetch = globalThis.fetch) {
    this.calendarId = calendarId;
    this.clientEmail = clientEmail;
    this.privateKey = privateKey;
    this.fetchImpl = fetchImpl;
  }

  // Very simplified JWT signing without external dependencies
  private async getAccessToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExp) {
      return this.token;
    }

    const header = { alg: "RS256", typ: "JWT" };
    const now = Math.floor(Date.now() / 1000);
    const claim = {
      iss: this.clientEmail,
      scope: "https://www.googleapis.com/auth/calendar",
      aud: "https://oauth2.googleapis.com/token",
      exp: now + 3600,
      iat: now,
    };

    const encodeB64 = (obj: any) => Buffer.from(JSON.stringify(obj)).toString("base64url");
    const signInput = `${encodeB64(header)}.${encodeB64(claim)}`;

    // Strip header/footer and newlines to parse PEM key for WebCrypto
    const pemContents = this.privateKey
      .replace(/-----BEGIN PRIVATE KEY-----/, "")
      .replace(/-----END PRIVATE KEY-----/, "")
      .replace(/\n/g, "");

    const binaryDerString = atob(pemContents);
    const binaryDer = new Uint8Array(binaryDerString.length);
    for (let i = 0; i < binaryDerString.length; i++) {
      binaryDer[i] = binaryDerString.charCodeAt(i);
    }

    const key = await crypto.subtle.importKey(
      "pkcs8",
      binaryDer.buffer,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const signatureBytes = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(signInput)
    );
    const signature = Buffer.from(signatureBytes).toString("base64url");
    const jwt = `${signInput}.${signature}`;

    const res = await this.fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    });

    if (!res.ok) {
      throw new Error(`Google Auth failed: ${await res.text()}`);
    }

    const data = await res.json() as any;
    this.token = data.access_token;
    this.tokenExp = Date.now() + (data.expires_in - 60) * 1000;
    return this.token!;
  }

  async checkAvailability(startTime: string, endTime: string): Promise<boolean> {
    const token = await this.getAccessToken();
    const res = await this.fetchImpl(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}/events?timeMin=${encodeURIComponent(startTime)}&timeMax=${encodeURIComponent(endTime)}&singleEvents=true`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) throw new Error("Failed to check GC availability");
    const data = await res.json() as any;
    return data.items && data.items.length === 0;
  }

  async createEvent(event: Omit<CalendarEvent, "id"> & { id?: string }): Promise<CalendarEvent> {
    const token = await this.getAccessToken();
    const payload = {
      summary: event.title,
      description: event.description,
      start: { dateTime: event.startTime },
      end: { dateTime: event.endTime },
      attendees: event.attendees?.map(email => ({ email })), // using phone numbers as emails for mockup per previous design
    };

    const res = await this.fetchImpl(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}/events`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );
    if (!res.ok) throw new Error("Failed to create GC event");
    const data = await res.json() as any;
    return { ...event, id: data.id || event.id || generateId("ev") };
  }

  async updateEvent(id: string, updates: Partial<CalendarEvent>): Promise<CalendarEvent> {
    const token = await this.getAccessToken();
    const payload: any = {};
    if (updates.title) payload.summary = updates.title;
    if (updates.description) payload.description = updates.description;
    if (updates.startTime) payload.start = { dateTime: updates.startTime };
    if (updates.endTime) payload.end = { dateTime: updates.endTime };
    if (updates.attendees) payload.attendees = updates.attendees.map(email => ({ email }));

    const res = await this.fetchImpl(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}/events/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );
    if (!res.ok) throw new Error("Failed to update GC event");
    const data = await res.json() as any;
    return {
      id: data.id,
      title: data.summary,
      description: data.description,
      startTime: data.start?.dateTime,
      endTime: data.end?.dateTime,
      attendees: data.attendees?.map((a: any) => a.email),
    };
  }

  async deleteEvent(id: string): Promise<void> {
    const token = await this.getAccessToken();
    const res = await this.fetchImpl(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}/events/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    if (!res.ok) throw new Error("Failed to delete GC event");
  }

  async listEvents(start: string, end: string): Promise<CalendarEvent[]> {
    const token = await this.getAccessToken();
    const res = await this.fetchImpl(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}/events?timeMin=${encodeURIComponent(start)}&timeMax=${encodeURIComponent(end)}&singleEvents=true`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) throw new Error("Failed to list GC events");
    const data = await res.json() as any;
    return (data.items || []).map((item: any) => ({
      id: item.id,
      title: item.summary,
      description: item.description,
      startTime: item.start?.dateTime,
      endTime: item.end?.dateTime,
      attendees: item.attendees?.map((a: any) => a.email),
    }));
  }
}

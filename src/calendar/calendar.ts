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
  createEvent(event: CalendarEvent): Promise<CalendarEvent>;
  listEvents(start: string, end: string): Promise<CalendarEvent[]>;
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

  async createEvent(event: CalendarEvent): Promise<CalendarEvent> {
    const available = await this.checkAvailability(event.startTime, event.endTime);
    if (!available) {
      throw new Error(`Calendar slot from ${event.startTime} to ${event.endTime} is not available.`);
    }
    this.events.push(event);
    return event;
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

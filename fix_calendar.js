import fs from 'fs';

let content = fs.readFileSync('src/calendar/calendar.ts', 'utf-8');
content = content.replace(
  `  createEvent(event: CalendarEvent): Promise<CalendarEvent>;
  listEvents(start: string, end: string): Promise<CalendarEvent[]>;`,
  `  createEvent(event: CalendarEvent): Promise<CalendarEvent>;
  listEvents(start: string, end: string): Promise<CalendarEvent[]>;
  updateEvent(id: string, updates: Partial<CalendarEvent>): Promise<CalendarEvent>;
  deleteEvent(id: string): Promise<void>;`
);

content = content.replace(
  `  async listEvents(start: string, end: string): Promise<CalendarEvent[]> {`,
  `  async updateEvent(id: string, updates: Partial<CalendarEvent>): Promise<CalendarEvent> {
    const idx = this.events.findIndex(e => e.id === id);
    if (idx === -1) throw new Error(\`Event \${id} not found\`);

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
      if (conflict) throw new Error(\`Calendar slot is not available.\`);
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

  async listEvents(start: string, end: string): Promise<CalendarEvent[]> {`
);

fs.writeFileSync('src/calendar/calendar.ts', content);

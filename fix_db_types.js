import fs from 'fs';

let content = fs.readFileSync('src/types/db.ts', 'utf-8');

content += `
export interface EstimateStatus {
  id: string;
  customerName: string;
  customerPhone: string;
  amount: number;
  status: "open" | "replied" | "closed";
  touchesSent: string; // JSON array of touch days e.g. "[2, 5]"
  nextTouchAt?: string; // ISO string
  stopReason?: string;
  createdAt: string;
}

export interface ReviewStatus {
  id: string; // usually bookingId
  bookingLink: string;
  sendAt: string; // ISO string
  status: "pending" | "sent" | "cancelled";
  createdAt: string;
}
`;

fs.writeFileSync('src/types/db.ts', content);

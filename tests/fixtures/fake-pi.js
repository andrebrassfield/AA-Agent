#!/usr/bin/env node

import readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const input = JSON.parse(line);
    if (input.type === "user_message") {
      if (input.content === "Hello Pi") {
        process.stdout.write(JSON.stringify({ type: "message", message: { role: "assistant", content: "Echoing Pi: Hello Pi" } }) + '\n');
        process.stdout.write(JSON.stringify({ type: "usage", usage: { provider: "pi-stub", model: "stub", prompt_tokens: 10, completion_tokens: 5, cost_usd: 0.001 } }) + '\n');
        process.stdout.write(JSON.stringify({ type: "agent_settled" }) + '\n');
      } else if (input.content.includes("are you an AI robot")) {
        process.stdout.write(JSON.stringify({ type: "message", message: { role: "assistant", content: "I am an automated AI assistant" } }) + '\n');
        process.stdout.write(JSON.stringify({ type: "usage", usage: { provider: "pi-stub", model: "stub", prompt_tokens: 10, completion_tokens: 5, cost_usd: 0.001 } }) + '\n');
        process.stdout.write(JSON.stringify({ type: "agent_settled" }) + '\n');
      } else if (input.content.includes("Book an AC Tune-Up") || input.content.includes("book an AC Tune-Up")) {
        // Find safe time for Monday 2 PM
        const safeTime = new Date();
        safeTime.setUTCHours(14, 0, 0, 0); // 2 PM UTC
        while (safeTime.getUTCDay() !== 1) {
            safeTime.setDate(safeTime.getDate() + 1);
        }
        process.stdout.write(JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: "Booking now...",
            tool_calls: [
              { function: { name: "manageBooking", arguments: JSON.stringify({ action: "create", input: { customerName: "Marcus Vance", customerPhone: "+14795554321", serviceId: "ac-tuneup", requestedStartTime: safeTime.toISOString() } }) } }
            ]
          }
        }) + '\n');
        process.stdout.write(JSON.stringify({ type: "agent_settled" }) + '\n');
      } else if (input.content.includes("reschedule") || input.content.includes("push that AC Tune-Up")) {
        const safeTime = new Date();
        safeTime.setUTCHours(14, 0, 0, 0);
        while (safeTime.getUTCDay() !== 1) {
            safeTime.setDate(safeTime.getDate() + 1);
        }
        const safeTime2 = new Date(safeTime.getTime() + 3600*1000);
        process.stdout.write(JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: "Rescheduling now...",
            tool_calls: [
              { function: { name: "manageBooking", arguments: JSON.stringify({ action: "reschedule", bookingId: "mock-id-123", requestedStartTime: safeTime2.toISOString() }) } }
            ]
          }
        }) + '\n');
        process.stdout.write(JSON.stringify({ type: "agent_settled" }) + '\n');
      } else {
        process.stdout.write(JSON.stringify({ type: "agent_settled" }) + '\n');
      }
    }
  } catch (err) {}
});

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
    const userMessage = input.userMessage || '';
    let reply = `Echoing from fake harness: ${userMessage}`;

    // Simulate AI disclosure guardrail honoring natively from harness if needed
    if (userMessage.toLowerCase().includes("robot")) {
        reply = "I am an automated AI assistant";
    }

    const output = {
      reply,
      actionTaken: {
        type: "INFO_PROVIDED",
        details: { harness: "fake-omp" }
      }
    };

    process.stdout.write(JSON.stringify(output) + '\n');
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err.message }) + '\n');
  }
});

#!/usr/bin/env node

// Hanging OMP fixture: reads stdin and stays alive without emitting a newline response
// so OmpEngine's per-turn deadline and SIGKILL cleanup are exercised deterministically.
import { writeFileSync } from "node:fs";

const pidFile = process.argv[2];
if (pidFile) {
  writeFileSync(pidFile, String(process.pid), "utf-8");
}

process.stdin.resume();
setInterval(() => {}, 60_000);

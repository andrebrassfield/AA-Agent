#!/usr/bin/env bun
import { main } from "../src/index.ts";

main().then((code) => {
  if (code !== 0) {
    process.exit(code);
  }
}).catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

#!/usr/bin/env bun

const MIN_BUN_VERSION = "1.1.0";

function parseSemver(version) {
  const clean = String(version || "")
    .trim()
    .replace(/^v/i, "")
    .split("-")[0]
    .split("+")[0];
  const parts = clean.split(".");
  if (parts.length < 3) return null;
  const nums = [Number(parts[0]), Number(parts[1]), Number(parts[2])];
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
  return nums;
}

function isVersionSupported(current, minimum) {
  const cur = parseSemver(current);
  const min = parseSemver(minimum);
  if (!cur || !min) return false;
  for (let i = 0; i < 3; i++) {
    if (cur[i] > min[i]) return true;
    if (cur[i] < min[i]) return false;
  }
  return true;
}

if (typeof Bun === "undefined" || !Bun.version) {
  console.error(
    `AA Book requires Bun v${MIN_BUN_VERSION} or newer, and Bun was not detected on this machine.\n` +
      `Install Bun with: curl -fsSL https://bun.sh/install | bash\n` +
      `Then reopen your terminal and run this command again.`
  );
  process.exit(1);
}

if (!isVersionSupported(Bun.version, MIN_BUN_VERSION)) {
  console.error(
    `AA Book requires Bun v${MIN_BUN_VERSION} or newer, and this machine has Bun v${Bun.version}.\n` +
      `Update Bun by running: bun upgrade\n` +
      `Then run this command again.`
  );
  process.exit(1);
}

const { main } = await import("../src/index.ts");

main()
  .then((code) => {
    if (code !== 0) {
      process.exit(code);
    }
  })
  .catch((err) => {
    console.error("Fatal error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });

import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";

const execFile = promisify(execFileCallback);

function parseEnv(output) {
  return Object.fromEntries(output.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    return match ? [[match[1], match[2]]] : [];
  }));
}

const { stdout } = await execFile("supabase", ["status", "-o", "env"], { cwd: resolve(import.meta.dirname, "..") });
const status = parseEnv(stdout);
if (!status.API_URL || !status.SERVICE_ROLE_KEY) {
  throw new Error("Local Supabase is not running. Start it with `supabase start` and retry.");
}

const pairingToken = randomBytes(32).toString("base64url");
const output = [
  "FOLLOWUP_SERVICE_HOST=127.0.0.1",
  "FOLLOWUP_SERVICE_PORT=4317",
  `FOLLOWUP_SUPABASE_URL=${status.API_URL}`,
  `FOLLOWUP_SUPABASE_SERVICE_ROLE_KEY=${status.SERVICE_ROLE_KEY}`,
  `FOLLOWUP_PAIRING_TOKEN=${pairingToken}`,
  "",
].join("\n");
await writeFile(resolve(import.meta.dirname, ".env"), output, { mode: 0o600 });
console.log("Local service configured. Copy FOLLOWUP_PAIRING_TOKEN from local-service/.env into the extension Settings panel.");

import * as http from 'http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import app from "./app";
import { logger } from "./lib/logger";
import { attachTerminalServer } from "./lib/terminalServer";

// Load environment variables from .env files before anything else
function loadEnvFile(filePath: string) {
  if (!existsSync(filePath)) return false;
  try {
    const raw = readFileSync(filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      if (!key || process.env[key]) continue; // Don't override existing env vars
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
    return true;
  } catch (err) {
    logger.warn({ err, filePath }, 'Failed to load env file');
    return false;
  }
}

// Try to load .env files from workspace root (2 levels up from built dist folder)
const workspaceRoot = path.resolve(__dirname, '..', '..', '..');
const envCandidates = [
  path.join(workspaceRoot, '.env.local'),
  path.join(workspaceRoot, '.env'),
  path.join(process.cwd(), '.env.local'),
  path.join(process.cwd(), '.env'),
];

for (const envPath of envCandidates) {
  if (loadEnvFile(envPath)) {
    logger.info({ envPath }, 'Loaded environment file');
  }
}

const rawPort = process.env["PORT"] ?? "8080";

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Use an explicit http.Server so we can attach the WebSocket terminal server
// to the same port — WebSocket upgrades share the HTTP listener.
const server = http.createServer(app);
attachTerminalServer(server);

server.listen(port, () => {
  logger.info({ port }, "Server listening");
});

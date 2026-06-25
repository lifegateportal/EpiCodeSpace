import * as http from 'http';
import app from "./app";
import { logger } from "./lib/logger";
import { attachTerminalServer } from "./lib/terminalServer";

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

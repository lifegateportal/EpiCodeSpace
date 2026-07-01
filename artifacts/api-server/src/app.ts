import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "node:path";
import { existsSync } from "node:fs";
import router from "./routes";
import { previewProxy } from "./lib/previewProxy";
import { logger } from "./lib/logger";

const app: Express = express();
const frontendRoot = path.resolve(__dirname, "../../epicodespace/dist/public");
const frontendIndex = path.join(frontendRoot, "index.html");

// Cross-origin isolation headers — required for WebContainers (SharedArrayBuffer).
// Must be on every response so the browser allows `window.crossOriginIsolated = true`.
// Excluded for /api/preview/* because those responses are the user's own dev server
// content, which must be able to load third-party scripts and assets freely.
app.use((_req, res, next) => {
  if (!_req.path.startsWith('/api/preview')) {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  }
  next();
});

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());

// Preview proxy — mounted BEFORE body-parsing middleware so that proxy
// requests are streamed directly without Express consuming their bodies.
// Handles /api/preview/<sessionId>/* → localhost:<detectedPort>/*
app.use('/api/preview', previewProxy);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use("/api", router);

if (process.env["NODE_ENV"] === "production" && existsSync(frontendIndex)) {
  app.use(express.static(frontendRoot));

  app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => {
    res.sendFile(frontendIndex);
  });

  logger.info({ frontendRoot }, "serving frontend bundle from API server");
} else if (process.env["NODE_ENV"] === "production") {
  logger.warn({ frontendRoot }, "frontend bundle not found; static app serving disabled");
}

export default app;

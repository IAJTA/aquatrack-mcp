import { AquaTrackClient } from "./aquatrack/client.js";
import { createLogger } from "./logger.js";
import { buildApp } from "./http/app.js";
import { loadConfig } from "./config.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = createLogger(cfg.logLevel);

  logger.info("AquaTrack MCP gateway starting...", {
    port: cfg.port,
    upstream: cfg.aquatrackUrl,
  });

  const app = buildApp(cfg, logger);

  const server = app.listen(cfg.port, () => {
    logger.info(`HTTP server listening on http://localhost:${cfg.port}`);
  });

  const shutdown = () => {
    logger.info("Shutting down HTTP server...");
    server.close(() => {
      logger.info("Server closed successfully.");
      process.exit(0);
    });
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  process.stderr.write(
    `Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});

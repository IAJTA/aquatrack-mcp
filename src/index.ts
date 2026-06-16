import { AquaTrackClient } from "./aquatrack/client.js";
import { createLogger } from "./logger.js";
import { buildApp } from "./http/app.js";
import { loadConfig } from "./config.js";
import { createMcpServer } from "./mcp/server.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = createLogger(cfg.logLevel);

  logger.info("AquaTrack MCP gateway starting...", {
    port: cfg.port,
    upstream: cfg.aquatrackUrl,
  });

  let baseClient: AquaTrackClient;
  try {
    logger.info("Authenticating test user...");
    const authResult = await AquaTrackClient.authenticate(
      cfg,
      "alejandrocastellonfer@gmail.com",
      "12345678",
    );
    baseClient = new AquaTrackClient(cfg, authResult.cookies);
    logger.info("Authentication successful!", {
      email: authResult.profile?.email,
    });
  } catch (error) {
    logger.error("Authentication failed.", {
      error: String(error),
    });
    baseClient = new AquaTrackClient(cfg, []);
  }

  const mcpServer = createMcpServer(logger, baseClient);
  const app = buildApp(cfg, logger, mcpServer);

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

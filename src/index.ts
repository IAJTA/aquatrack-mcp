import { loadConfig, secretsOf } from "./config.js";
import { createLogger } from "./logger.js";
import { SessionStore } from "./auth/sessions.js";
import { AquaTrackOAuthProvider } from "./auth/provider.js";
import { buildApp } from "./http/app.js";

function main(): void {
  const cfg = loadConfig();
  const logger = createLogger(cfg.logLevel, secretsOf(cfg));
  const sessions = new SessionStore(cfg, logger);
  const provider = new AquaTrackOAuthProvider(cfg, sessions, logger);
  const app = buildApp(cfg, provider, sessions, logger);

  const httpServer = app.listen(cfg.port, () => {
    logger.info("AquaTrack MCP gateway listening", {
      port: cfg.port,
      publicUrl: cfg.publicUrl,
      mcpEndpoint: `${cfg.publicUrl}/mcp`,
      oauth: cfg.oauthEnabled,
      staticBearer: Boolean(cfg.evalToken),
      aquatrackUrl: cfg.aquatrackUrl,
    });
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down: draining HTTP connections", { signal });
    httpServer.close((err) => {
      if (err) logger.error("Error during shutdown", { reason: err.message });
      else logger.info("Drained cleanly; exiting");
      process.exit(err ? 1 : 0);
    });

    setTimeout(() => {
      logger.warn("Drain timed out; forcing exit");
      process.exit(0);
    }, 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

try {
  main();
} catch (err) {
  process.stderr.write(
    `Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}

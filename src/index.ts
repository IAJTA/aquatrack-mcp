import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";

function main(): void {
  const cfg = loadConfig();
  const logger = createLogger(cfg.logLevel);

  logger.info("AquaTrack MCP gateway starting...", {
    port: cfg.port
  });

  logger.info("AquaTrack MCP gateway successfully initialized.");
}

try {
  main();
} catch (err) {
  process.stderr.write(
    `Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}

import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { AquaTrackClient } from "./aquatrack/client.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = createLogger(cfg.logLevel);

  logger.info("AquaTrack MCP gateway starting...", {
    port: cfg.port,
    upstream: cfg.aquatrackUrl,
  });

  try {
    logger.info("Initializing AquaTrack client...");
    const { cookies } = await AquaTrackClient.authenticate(
      cfg,
      "alejandrocastellonfer@gmail.com",
      "12345678",
    );
    const client = new AquaTrackClient(cfg, cookies);
    const buildings = await client.getBuildings();
    logger.info("Found buildings", { count: buildings.length });
  } catch (e) {
    logger.warn("AquaTrack API test failed");
  }

  logger.info("AquaTrack MCP gateway successfully initialized.");
}

main().catch((err) => {
  process.stderr.write(
    `Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "../logger.js";
import { registerAquaTrackTools } from "./tools.js";
import { AquaTrackClient } from "../aquatrack/client.js";

export function createMcpServer(
  logger: Logger,
  client: AquaTrackClient,
): McpServer {
  const server = new McpServer(
    { name: "aquatrack-mcp", version: "1.0.0" },
    { capabilities: { tools: {} }, instructions: "AquaTrack MCP Server" },
  );

  registerAquaTrackTools(server, logger, client);

  return server;
}

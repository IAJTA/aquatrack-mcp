import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "../logger.js";
import { AquaTrackClient } from "../aquatrack/client.js";
import { result, joinLines } from "./format.js";

export function registerAquaTrackTools(
  server: McpServer,
  logger: Logger,
  client: AquaTrackClient,
): void {
  server.tool("list_buildings", "List all buildings.", async () => {
    try {
      const buildings = await client.getBuildings();
      if (!buildings || buildings.length === 0) {
        return result("No buildings found.", { buildings });
      }
      const lines = buildings.map(
        (b) => `${b.name} ${b.address} ${b.totalApartments} apartments`,
      );
      return result(joinLines([`${buildings.length} building(s):`, ...lines]), {
        buildings,
      });
    } catch (error) {
      logger.error("Error fetching buildings", { error: String(error) });
      return {
        content: [{ type: "text", text: `Error: ${String(error)}` }],
        isError: true,
      };
    }
  });
}

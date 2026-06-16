import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { SessionStore } from "../auth/sessions.js";
import { registerAquaTrackTools } from "./tools.js";

const INSTRUCTIONS = `AquaTrack is an IoT water-monitoring platform. Tools answer questions about water
consumption, billing and meter health, scoped to whatever the connected account is allowed to see.

The connected account has one of four roles — adapt to it (call whoami if unsure):
- admin / super_admin: manage whole buildings. Start with list_buildings, then pass a building NAME
  (or UUID) to get_building_overview, get_building_billing, get_top_consumers, list_apartments, etc.
  Only super_admin can use list_water_meters.
- owner / tenant: see only their own apartments. Start with my_apartments, then use
  get_apartment / get_apartment_consumption_history for one of those apartments.

Tips:
- get_building_overview is the fastest way to summarize a building's current water situation (admins).
- Monthly billing is m³ and payments are Bs (Bolivianos); daily series are in litres.
- recalculate_consumption only recomputes derived totals; it never changes buildings, tenants or bills.
- If a tool returns a 403/role error, tell the user which role is required rather than retrying.`;

export function createMcpServer(
  cfg: Config,
  sessions: SessionStore,
  logger: Logger,
): McpServer {
  const server = new McpServer(
    { name: cfg.serverName, version: cfg.serverVersion },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  registerAquaTrackTools(server, sessions, logger);
  return server;
}

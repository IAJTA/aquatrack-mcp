import cors from "cors";
import express, { type Request, type Response } from "express";
import type { Config } from "../config.ts";
import type { Logger } from "../logger.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

export function buildApp(
  cfg: Config,
  logger: Logger,
  mcpServer: McpServer,
): express.Express {
  const app = express();
  app.disable("x-powered-by");

  app.use(cors());

  // Health check
  app.get("/healthz", (req: Request, res: Response) => {
    res.json({ status: "ok", port: cfg.port });
  });

  // Root endpoint
  app.get("/", (req: Request, res: Response) => {
    res.json({
      name: "aquatrack-mcp",
      status: "ok",
      message:
        "Gateway HTTP server is running. Connect your MCP Client to /sse",
    });
  });

  let transport: SSEServerTransport | undefined;

  // MCP SSE connection
  app.get("/sse", async (req: Request, res: Response) => {
    try {
      if (transport) {
        try {
          await transport.close();
        } catch {}
      }
      transport = new SSEServerTransport("/messages", res);
      await mcpServer.connect(transport);
      res.on("close", () => {
        logger.info("SSE Connection closed by client");
      });
      logger.info("New MCP client connected via SSE");
    } catch (e) {
      logger.error("SSE Connection error", { error: String(e) });
    }
  });

  // MCP messages
  app.post("/messages", async (req: Request, res: Response) => {
    if (!transport) {
      res.status(503).json({ error: "No active SSE connection" });
      return;
    }
    try {
      await transport.handlePostMessage(req, res);
    } catch (e) {
      logger.error("Error handling POST message", { error: String(e) });
    }
  });

  // 404 catch-all
  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: "not_found", message: "Unknown endpoint." });
  });

  return app;
}

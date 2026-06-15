import cors from "cors";
import express, { type Request, type Response } from "express";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";

export function buildApp(cfg: Config, logger: Logger): express.Express {
  const app = express();
  app.disable("x-powered-by");

  app.use(cors());
  app.use(express.json());

  // Health check
  app.get("/healthz", (req: Request, res: Response) => {
    res.json({ status: "ok", port: cfg.port });
  });

  // Root endpoint
  app.get("/", (req: Request, res: Response) => {
    res.json({
      name: "aquatrack-mcp",
      status: "ok",
      message: "Gateway HTTP server is running",
    });
  });

  // 404 catch-all
  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: "not_found", message: "Unknown endpoint." });
  });

  return app;
}

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { SessionStore } from "../auth/sessions.js";
import type { AquaTrackOAuthProvider } from "../auth/provider.js";
import { createMcpServer } from "../mcp/server.js";
import { renderLoginPage } from "../auth/login-page.js";
import { AquaTrackClient, LoginError } from "../aquatrack/client.js";
import { requestId, securityHeaders, createRateLimiter } from "./middleware.js";

export function buildApp(
  cfg: Config,
  provider: AquaTrackOAuthProvider,
  sessions: SessionStore,
  logger: Logger,
): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", cfg.trustProxy);

  app.use(requestId);
  app.use(securityHeaders);

  const __dirname = fileURLToPath(new URL(".", import.meta.url));
  app.use(
    "/assets",
    express.static(join(__dirname, "..", "..", "assets"), {
      maxAge: "7d",
      immutable: true,
    }),
  );

  app.use(
    cors({
      origin: cfg.allowedOrigins.length ? cfg.allowedOrigins : true,
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "Mcp-Session-Id",
        "Mcp-Protocol-Version",
        "Last-Event-ID",
      ],
      exposedHeaders: ["Mcp-Session-Id", "WWW-Authenticate"],
    }),
  );

  // Health check
  app.get("/healthz", (_req, res) => {
    res.json({
      status: "ok",
      server: cfg.serverName,
      version: cfg.serverVersion,
      oauth: cfg.oauthEnabled,
    });
  });

  // Root: server info
  app.get("/", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({
      name: cfg.serverName,
      version: cfg.serverVersion,
      status: "ok",
      transport: "streamable-http",
      mcpEndpoint: `${cfg.publicUrl}/mcp`,
      oauth: cfg.oauthEnabled,
    });
  });

  // OAuth login page
  if (cfg.oauthEnabled) {
    function loginCsp(nonce: string): string {
      return [
        "default-src 'none'",
        `script-src 'nonce-${nonce}' https://static.cloudflareinsights.com`,
        "style-src 'unsafe-inline'",
        "img-src 'self'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join("; ");
    }

    function sendLoginPage(
      res: Response,
      status: number,
      opts: { loginId: string; resourceName: string; error?: string },
    ): void {
      const nonce = randomUUID();
      res.setHeader("Content-Security-Policy", loginCsp(nonce));
      res
        .status(status)
        .type("html")
        .send(renderLoginPage({ ...opts, nonce }));
    }

    const loginLimiter = createRateLimiter({
      max: 5,
      windowMs: 60_000,
      onLimit: (req, res, retryAfter) => {
        logger.warn("Login rate limit hit", { ip: req.ip, requestId: req.id });
        const loginId = String(
          (req.body as { login_id?: string } | undefined)?.login_id ?? "",
        );
        sendLoginPage(res, 429, {
          loginId,
          resourceName: cfg.resourceName,
          error: `Demasiados intentos. Espera ${retryAfter}s e inténtalo de nuevo.`,
        });
      },
    });

    app.get("/login", (req: Request, res: Response) => {
      const loginId = String(req.query.login_id ?? "");
      if (!provider.getPendingLogin(loginId)) {
        sendLoginPage(res, 400, {
          loginId,
          resourceName: cfg.resourceName,
          error:
            "This sign-in request has expired. Please start again from your assistant.",
        });
        return;
      }
      sendLoginPage(res, 200, { loginId, resourceName: cfg.resourceName });
    });

    app.post(
      "/login",
      express.urlencoded({ extended: false }),
      loginLimiter,
      async (req: Request, res: Response) => {
        try {
          const body = req.body as {
            login_id?: string;
            email?: string;
            password?: string;
          };
          const loginId = String(body.login_id ?? "");
          logger.debug("Login POST received", { loginId, hasEmail: Boolean(body.email) });

          if (!loginId || !provider.getPendingLogin(loginId)) {
            sendLoginPage(res, 400, {
              loginId,
              resourceName: cfg.resourceName,
              error:
                "This sign-in request has expired. Please start again from your assistant.",
            });
            return;
          }
          const email = String(body.email ?? "").trim();
          const password = String(body.password ?? "");
          if (!email || !password) {
            sendLoginPage(res, 400, {
              loginId,
              resourceName: cfg.resourceName,
              error: "Email and password are required.",
            });
            return;
          }

          const { cookies, profile } = await AquaTrackClient.authenticate(
            cfg,
            email,
            password,
            logger,
          );
          const session = sessions.createUserSession(cookies, profile);
          res.redirect(302, provider.completeLogin(loginId, session.id));
        } catch (e) {
          logger.warn("OAuth login failed", {
            requestId: req.id,
            reason: logger.redact(e instanceof Error ? e.message : String(e)),
          });
          const message =
            e instanceof LoginError
              ? e.message
              : "Sign-in failed. Please try again.";
          const loginId = String(
            ((req.body as { login_id?: string } | undefined)?.login_id ?? ""),
          );
          sendLoginPage(res, 401, {
            loginId,
            resourceName: cfg.resourceName,
            error: message,
          });
        }
      },
    );

    app.use(
      mcpAuthRouter({
        provider,
        issuerUrl: new URL(cfg.publicUrl),
        resourceServerUrl: new URL(`${cfg.publicUrl}/mcp`),
        scopesSupported: cfg.scopesSupported,
        resourceName: cfg.resourceName,
      }),
    );
  }

  // MCP endpoint
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(
    new URL(`${cfg.publicUrl}/mcp`),
  );
  const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl });

  app.post(
    "/mcp",
    bearer,
    express.json({ limit: "1mb" }),
    async (req: Request, res: Response) => {
      const server = createMcpServer(cfg, sessions, logger);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        enableDnsRebindingProtection: cfg.dnsRebindingProtection,
        allowedHosts: cfg.allowedHosts,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (e) {
        logger.error("MCP request handling failed", {
          requestId: req.id,
          reason: logger.redact(e instanceof Error ? e.message : String(e)),
        });
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          });
        }
      }
    },
  );

  // Stateless mode
  const methodNotAllowed = (_req: Request, res: Response) => {
    res
      .status(405)
      .set("Allow", "POST")
      .json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Method not allowed. This MCP endpoint accepts POST only.",
        },
        id: null,
      });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

    // Error handler
  app.use(
    (
      err: Error,
      req: Request,
      res: Response,
      _next: NextFunction,
    ) => {
      logger.error("Unhandled error", {
        requestId: req.id,
        reason: logger.redact(err.message),
      });
      if (res.headersSent) return;
      res.status(500).type("html").send("Internal server error.");
    },
  );

  // Catch-all
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: "not_found",
      message: "Unknown endpoint.",
      requestId: req.id,
    });
  });

  return app;
}

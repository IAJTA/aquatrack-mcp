import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction, RequestHandler } from "express";

declare module "express-serve-static-core" {
  interface Request {
    id?: string;
  }
}

export const requestId: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const incoming = req.header("x-request-id");
  req.id = incoming && incoming.length <= 200 ? incoming : randomUUID();
  res.setHeader("X-Request-Id", req.id);
  next();
};

export const securityHeaders: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-DNS-Prefetch-Control", "off");

  if (req.secure) {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }
  next();
};

interface RateLimiterOptions {
  max: number;
  windowMs: number;
  onLimit: (req: Request, res: Response, retryAfterSec: number) => void;
}

export function createRateLimiter(opts: RateLimiterOptions): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = req.ip ?? "unknown";
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + opts.windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > opts.max) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      opts.onLimit(req, res, retryAfter);
      return;
    }

    if (hits.size > 5000) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    }
    next();
  };
}

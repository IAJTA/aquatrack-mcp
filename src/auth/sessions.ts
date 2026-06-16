import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { AquaTrackClient, type AquaSession } from "../aquatrack/client.js";
import type { Profile } from "../aquatrack/types.js";

const SERVICE_SESSION_ID = "service";

export class SessionStore {
  private readonly sessions = new Map<string, AquaSession>();
  private serviceInflight: Promise<AquaSession> | null = null;

  constructor(
    private readonly cfg: Config,
    private readonly logger: Logger,
  ) {}

  createUserSession(cookies: string[], profile?: Profile): AquaSession {
    const session: AquaSession = {
      id: randomUUID(),
      kind: "user",
      cookies,
      profile,
      inflightReauth: null,
    };
    this.sessions.set(session.id, session);
    this.logger.info("Created user session", {
      sessionId: session.id,
      role: profile?.role,
    });
    return session;
  }

  get(id: string): AquaSession | undefined {
    return this.sessions.get(id);
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }

  async ensureServiceSession(): Promise<AquaSession> {
    const existing = this.sessions.get(SERVICE_SESSION_ID);
    if (existing) return existing;
    if (this.serviceInflight) return this.serviceInflight;

    if (!this.cfg.serviceEmail || !this.cfg.servicePassword) {
      throw new Error(
        "Service credentials are not configured (AQUATRACK_SERVICE_EMAIL / _PASSWORD).",
      );
    }

    this.serviceInflight = (async () => {
      const { cookies, profile } = await AquaTrackClient.authenticate(
        this.cfg,
        this.cfg.serviceEmail!,
        this.cfg.servicePassword!,
        this.logger,
      );
      const session: AquaSession = {
        id: SERVICE_SESSION_ID,
        kind: "service",
        cookies,
        profile,
        serviceCreds: {
          email: this.cfg.serviceEmail!,
          password: this.cfg.servicePassword!,
        },
        inflightReauth: null,
      };
      this.sessions.set(SERVICE_SESSION_ID, session);
      this.logger.info("Service session established", { role: profile?.role });
      return session;
    })();

    try {
      return await this.serviceInflight;
    } finally {
      this.serviceInflight = null;
    }
  }

  clientFor(session: AquaSession): AquaTrackClient {
    return new AquaTrackClient(this.cfg, session, this.logger);
  }
}

export { SERVICE_SESSION_ID };

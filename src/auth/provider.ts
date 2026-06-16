import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Response } from "express";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidGrantError,
  InvalidTokenError,
  ServerError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { Config } from "../config.ts";
import type { Logger } from "../logger.ts";
import type { SessionStore } from "./sessions.ts";

interface PendingLogin {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  expiresAt: number;
}

interface AuthCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  sessionId: string;
  scopes: string[];
  expiresAt: number;
}

interface TokenRecord {
  clientId: string;
  scopes: string[];
  sessionId: string;
  expiresAt: number;
}

const LOGIN_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function token(): string {
  return randomBytes(32).toString("base64url");
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

class InMemoryClientsStore implements OAuthRegisteredClientsStore {
  private readonly clients = new Map<string, OAuthClientInformationFull>();

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }

  registerClient(
    client: Omit<
      OAuthClientInformationFull,
      "client_id" | "client_id_issued_at"
    >,
  ): OAuthClientInformationFull {
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),

      token_endpoint_auth_method: client.token_endpoint_auth_method ?? "none",
    };
    this.clients.set(full.client_id, full);
    return full;
  }
}

export class AquaTrackOAuthProvider implements OAuthServerProvider {
  readonly clientsStore = new InMemoryClientsStore();

  private readonly pendingLogins = new Map<string, PendingLogin>();
  private readonly authCodes = new Map<string, AuthCode>();
  private readonly accessTokens = new Map<string, TokenRecord>();
  private readonly refreshTokens = new Map<string, TokenRecord>();

  constructor(
    private readonly cfg: Config,
    private readonly sessions: SessionStore,
    private readonly logger: Logger,
  ) {}

  // OAuth
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const loginId = randomUUID();
    this.pendingLogins.set(loginId, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: this.grantScopes(params.scopes),
      expiresAt: Date.now() + LOGIN_TTL_MS,
    });
    this.logger.info("OAuth authorize started", { clientId: client.client_id });
    res.redirect(
      302,
      `${this.cfg.publicUrl}/login?login_id=${encodeURIComponent(loginId)}`,
    );
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const record = this.authCodes.get(authorizationCode);
    if (!record || record.expiresAt < Date.now()) {
      throw new InvalidGrantError("Authorization code is invalid or expired.");
    }
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const record = this.authCodes.get(authorizationCode);
    this.authCodes.delete(authorizationCode);
    if (!record || record.expiresAt < Date.now()) {
      throw new InvalidGrantError("Authorization code is invalid or expired.");
    }
    if (record.clientId !== client.client_id) {
      throw new InvalidGrantError(
        "Authorization code was issued to a different client.",
      );
    }
    if (redirectUri && redirectUri !== record.redirectUri) {
      throw new InvalidGrantError(
        "redirect_uri does not match the authorization request.",
      );
    }
    return this.issueTokens(record.clientId, record.scopes, record.sessionId);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const record = this.refreshTokens.get(refreshToken);
    if (!record || record.expiresAt < Date.now()) {
      throw new InvalidGrantError("Refresh token is invalid or expired.");
    }
    if (record.clientId !== client.client_id) {
      throw new InvalidGrantError(
        "Refresh token was issued to a different client.",
      );
    }
    if (!this.sessions.get(record.sessionId)) {
      this.refreshTokens.delete(refreshToken);
      throw new InvalidGrantError(
        "Underlying session no longer exists; re-authorization required.",
      );
    }
    this.refreshTokens.delete(refreshToken);
    const granted =
      scopes && scopes.length
        ? scopes.filter((s) => record.scopes.includes(s))
        : record.scopes;
    return this.issueTokens(record.clientId, granted, record.sessionId);
  }

  async verifyAccessToken(accessToken: string): Promise<AuthInfo> {
    if (
      this.cfg.evalToken &&
      constantTimeEqual(accessToken, this.cfg.evalToken)
    ) {
      const session = await this.sessions.ensureServiceSession();
      return {
        token: accessToken,
        clientId: "mcpjam-eval",
        scopes: this.cfg.scopesSupported,
        expiresAt:
          Math.floor(Date.now() / 1000) +
          Math.floor(this.cfg.accessTokenTtlMs / 1000),
        extra: { sessionId: session.id, kind: "service" },
      };
    }

    const record = this.accessTokens.get(accessToken);
    if (!record) {
      throw new InvalidTokenError("Unknown or revoked access token.");
    }
    if (record.expiresAt < Date.now()) {
      this.accessTokens.delete(accessToken);
      throw new InvalidTokenError("Access token expired.");
    }
    if (!this.sessions.get(record.sessionId)) {
      this.accessTokens.delete(accessToken);
      throw new InvalidTokenError(
        "Session no longer exists; re-authorization required.",
      );
    }
    return {
      token: accessToken,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: Math.floor(record.expiresAt / 1000),
      extra: { sessionId: record.sessionId, kind: "user" },
    };
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    this.accessTokens.delete(request.token);
    this.refreshTokens.delete(request.token);
  }

  getPendingLogin(loginId: string): PendingLogin | undefined {
    const login = this.pendingLogins.get(loginId);
    if (!login) return undefined;
    if (login.expiresAt < Date.now()) {
      this.pendingLogins.delete(loginId);
      return undefined;
    }
    return login;
  }

  completeLogin(loginId: string, sessionId: string): string {
    const login = this.pendingLogins.get(loginId);
    if (!login)
      throw new ServerError(
        "Login request expired. Please restart the connection.",
      );
    this.pendingLogins.delete(loginId);

    const code = token();
    this.authCodes.set(code, {
      clientId: login.clientId,
      redirectUri: login.redirectUri,
      codeChallenge: login.codeChallenge,
      sessionId,
      scopes: login.scopes,
      expiresAt: Date.now() + CODE_TTL_MS,
    });

    const url = new URL(login.redirectUri);
    url.searchParams.set("code", code);
    if (login.state) url.searchParams.set("state", login.state);
    return url.toString();
  }

  denyLogin(loginId: string, error = "access_denied"): string | undefined {
    const login = this.pendingLogins.get(loginId);
    if (!login) return undefined;
    this.pendingLogins.delete(loginId);
    const url = new URL(login.redirectUri);
    url.searchParams.set("error", error);
    if (login.state) url.searchParams.set("state", login.state);
    return url.toString();
  }

  // Internals
  private issueTokens(
    clientId: string,
    scopes: string[],
    sessionId: string,
  ): OAuthTokens {
    this.sweep();
    const accessToken = token();
    const refreshToken = token();
    const expiresAt = Date.now() + this.cfg.accessTokenTtlMs;
    this.accessTokens.set(accessToken, {
      clientId,
      scopes,
      sessionId,
      expiresAt,
    });
    this.refreshTokens.set(refreshToken, {
      clientId,
      scopes,
      sessionId,
      expiresAt: Date.now() + REFRESH_TTL_MS,
    });
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.floor(this.cfg.accessTokenTtlMs / 1000),
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }

  private grantScopes(requested?: string[]): string[] {
    if (!requested || requested.length === 0) return this.cfg.scopesSupported;
    return requested.filter((s) => this.cfg.scopesSupported.includes(s));
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.accessTokens)
      if (v.expiresAt < now) this.accessTokens.delete(k);
    for (const [k, v] of this.refreshTokens)
      if (v.expiresAt < now) this.refreshTokens.delete(k);
    for (const [k, v] of this.authCodes)
      if (v.expiresAt < now) this.authCodes.delete(k);
    for (const [k, v] of this.pendingLogins)
      if (v.expiresAt < now) this.pendingLogins.delete(k);
  }
}

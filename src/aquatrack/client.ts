import type { Config } from "../config.ts";
import type { Logger } from "../logger.ts";
import type {
  ApartmentMonthlyByBuilding,
  ApartmentWithRelations,
  Apartment,
  Building,
  BuildingDailyChange,
  BuildingDailyConsumption,
  BuildingMonthlyConsumption,
  Central,
  DailyConsumptionPoint,
  Profile,
  TopConsumer,
  WaterMeter,
  WaterReading,
} from "./types.ts";

export interface AquaSession {
  id: string;
  kind: "user" | "service";
  cookies: string[];
  profile?: Profile;
  serviceCreds?: { email: string; password: string };
  inflightReauth?: Promise<void> | null;
}

export class AuthExpiredError extends Error {
  constructor(
    message = "AquaTrack session expired; re-authorization required.",
  ) {
    super(message);
    this.name = "AuthExpiredError";
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function timedFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function extractCookies(res: Response): string[] {
  const setCookie = res.headers.getSetCookie?.() ?? [];
  return setCookie.map((c) => c.split(";")[0]).filter(Boolean);
}

function mergeCookies(existing: string[], incoming: string[]): string[] {
  const byName = new Map<string, string>();
  for (const c of [...existing, ...incoming]) {
    const name = c.split("=")[0];
    byName.set(name, c);
  }
  return [...byName.values()];
}

export class AquaTrackClient {
  constructor(
    private readonly cfg: Config,
    private readonly session: AquaSession,
    private readonly logger: Logger,
  ) {}

  static async authenticate(
    cfg: Config,
    email: string,
    password: string,
    logger: Logger,
  ): Promise<{ cookies: string[]; profile?: Profile }> {
    let res: Response;
    try {
      res = await timedFetch(
        `${cfg.aquatrackUrl}/api/v1/auth/login`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
          redirect: "manual",
        },
        cfg.requestTimeoutMs,
      );
    } catch (err) {
      throw new LoginError(
        `Could not reach AquaTrack to log in: ${logger.redact(String((err as Error).message))}`,
      );
    }

    if (res.status === 401 || res.status === 404) {
      throw new LoginError("Invalid AquaTrack email or password.");
    }
    if (res.status === 403) {
      throw new LoginError(
        "This AquaTrack account has not verified its email address.",
      );
    }
    if (!res.ok) {
      throw new LoginError(`AquaTrack login failed with (HTTP ${res.status}).`);
    }

    const cookies = extractCookies(res);
    if (!cookies.some((c) => c.startsWith("accessToken="))) {
      throw new LoginError(
        "AquaTrack login did not return an access token cookie.",
      );
    }

    let profile: Profile | undefined;
    try {
      const profRes = await timedFetch(
        `${cfg.aquatrackUrl}/api/v1/auth/profile`,
        { method: "GET", headers: { Cookie: cookies.join("; ") } },
        cfg.requestTimeoutMs,
      );
      if (profRes.ok) profile = (await profRes.json()) as Profile;
    } catch (error) {
      console.error("Error fetching profile:", error);
    }

    return { cookies, profile };
  }

  get profile(): Profile | undefined {
    return this.session.profile;
  }

  getBuildings(): Promise<Building[]> {
    return this.request("GET", "/api/v1/buildings");
  }

  getBuilding(id: string): Promise<Building> {
    return this.request("GET", `/api/v1/buildings/${encodeURIComponent(id)}`);
  }

  getApartmentsByBuilding(
    buildingId: string,
  ): Promise<ApartmentWithRelations[]> {
    return this.request(
      "GET",
      `/api/v1/apartments/building/${encodeURIComponent(buildingId)}`,
    );
  }

  getApartment(id: string): Promise<Apartment> {
    return this.request("GET", `/api/v1/apartments/${encodeURIComponent(id)}`);
  }

  getApartmentsByOwner(ownerId: string): Promise<Apartment[]> {
    return this.request(
      "GET",
      `/api/v1/apartments/owner/${encodeURIComponent(ownerId)}`,
    );
  }

  getApartmentsByTenant(tenantId: string): Promise<Apartment[]> {
    return this.request(
      "GET",
      `/api/v1/apartments/tenant/${encodeURIComponent(tenantId)}`,
    );
  }

  getWaterReading(apartmentId: string): Promise<WaterReading> {
    return this.request(
      "GET",
      `/api/v1/water-readings/apartment/${encodeURIComponent(apartmentId)}`,
    );
  }

  getApartmentDailyHistory(
    apartmentId: string,
  ): Promise<DailyConsumptionPoint[]> {
    return this.request(
      "GET",
      `/api/v1/apartments-consumption/daily/${encodeURIComponent(apartmentId)}`,
    );
  }

  getTopConsumers(buildingId: string, limit: number): Promise<TopConsumer[]> {
    return this.request(
      "GET",
      `/api/v1/apartments-consumption/top-consumers/yesterday/${encodeURIComponent(buildingId)}?limit=${limit}`,
    );
  }

  getApartmentsMonthlyByBuilding(
    buildingId: string,
    month: string,
  ): Promise<ApartmentMonthlyByBuilding[]> {
    return this.request(
      "GET",
      `/api/v1/apartments-consumption/monthly/${encodeURIComponent(buildingId)}?month=${encodeURIComponent(month)}`,
    );
  }

  getBuildingDaily(buildingId: string): Promise<BuildingDailyConsumption> {
    return this.request(
      "GET",
      `/api/v1/building-consumption/daily/${encodeURIComponent(buildingId)}`,
    );
  }

  getBuildingDailyChange(buildingId: string): Promise<BuildingDailyChange> {
    return this.request(
      "GET",
      `/api/v1/building-consumption/daily-change/${encodeURIComponent(buildingId)}`,
    );
  }

  getBuildingMonthly(
    buildingId: string,
    opts: { months?: number; startMonth?: string; endMonth?: string } = {},
  ): Promise<BuildingMonthlyConsumption[]> {
    const q = new URLSearchParams();
    if (opts.months) q.set("months", String(opts.months));
    if (opts.startMonth) q.set("startMonth", opts.startMonth);
    if (opts.endMonth) q.set("endMonth", opts.endMonth);
    const qs = q.toString();
    return this.request(
      "GET",
      `/api/v1/building-consumption/monthly/${encodeURIComponent(buildingId)}${qs ? `?${qs}` : ""}`,
    );
  }

  getCentralsByBuilding(buildingId: string): Promise<Central[]> {
    return this.request(
      "GET",
      `/api/v1/centrals/building/${encodeURIComponent(buildingId)}`,
    );
  }

  getWaterMeters(): Promise<WaterMeter[]> {
    return this.request("GET", "/api/v1/water-meters");
  }

  recalculateBuildingDaily(): Promise<{ message: string }> {
    return this.request("POST", "/api/v1/building-consumption/run-daily");
  }

  recalculateApartmentsDaily(): Promise<{
    message: string;
    timestamp: string;
  }> {
    return this.request(
      "POST",
      "/api/v1/apartments-consumption/calculate-daily",
    );
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.cfg.aquatrackUrl}${path}`;
    let attempt = 0;
    let didReauth = false;

    for (;;) {
      let res: Response;
      try {
        res = await timedFetch(
          url,
          {
            method,
            headers: {
              "Content-Type": "application/json",
              Cookie: this.session.cookies.join("; "),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          },
          this.cfg.requestTimeoutMs,
        );
      } catch (err) {
        const isAbort = (err as Error).name === "AbortError";
        if (attempt < this.cfg.maxRetries) {
          attempt += 1;
          await sleep(200 * 2 ** attempt);
          continue;
        }
        throw new ApiError(
          isAbort
            ? `AquaTrack request timed out after ${this.cfg.requestTimeoutMs}ms (${method} ${path}).`
            : `Network error calling AquaTrack: ${this.logger.redact(String((err as Error).message))}`,
        );
      }

      if (res.status === 401 && !didReauth) {
        didReauth = true;
        await this.reauth();
        continue;
      }

      if (
        (res.status >= 500 || res.status === 429) &&
        attempt < this.cfg.maxRetries
      ) {
        attempt += 1;
        await sleep(200 * 2 ** attempt);
        continue;
      }

      if (!res.ok) {
        const detail = this.logger.redact((await safeText(res)).slice(0, 500));
        throw new ApiError(
          httpMessage(res.status, method, path),
          res.status,
          detail,
        );
      }

      if (res.status === 204) return undefined as T;
      const text = await safeText(res);
      return (text ? JSON.parse(text) : undefined) as T;
    }
  }

  private async reauth(): Promise<void> {
    if (this.session.inflightReauth) return this.session.inflightReauth;

    const run = (async () => {
      try {
        await this.refresh();
        this.logger.debug("AquaTrack access token refreshed", {
          sessionId: this.session.id,
        });
        return;
      } catch (refreshErr) {
        this.logger.warn("AquaTrack token refresh failed", {
          sessionId: this.session.id,
          reason: this.logger.redact(String((refreshErr as Error).message)),
        });
      }

      if (this.session.kind === "service" && this.session.serviceCreds) {
        const { cookies, profile } = await AquaTrackClient.authenticate(
          this.cfg,
          this.session.serviceCreds.email,
          this.session.serviceCreds.password,
          this.logger,
        );
        this.session.cookies = cookies;
        this.session.profile = profile;
        this.logger.info("Service session re-logged in", {
          sessionId: this.session.id,
        });
        return;
      }
      throw new AuthExpiredError();
    })();

    this.session.inflightReauth = run;
    try {
      await run;
    } finally {
      this.session.inflightReauth = null;
    }
  }

  private async refresh(): Promise<void> {
    const res = await timedFetch(
      `${this.cfg.aquatrackUrl}/api/v1/auth/refresh`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: this.session.cookies.join("; "),
        },
      },
      this.cfg.requestTimeoutMs,
    );
    if (!res.ok) throw new Error(`refresh returned HTTP ${res.status}`);
    const fresh = extractCookies(res);
    if (!fresh.some((c) => c.startsWith("accessToken="))) {
      throw new Error("refresh did not return a new access token");
    }
    this.session.cookies = mergeCookies(this.session.cookies, fresh);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function httpMessage(status: number, method: string, path: string): string {
  switch (status) {
    case 400:
      return `AquaTrack rejected the request as invalid (400) for ${method} ${path}.`;
    case 403:
      return "Your AquaTrack account's role is not allowed to perform this action (403).";
    case 404:
      return `The requested AquaTrack resource was not found (404) for ${method} ${path}.`;
    default:
      return `AquaTrack API error (HTTP ${status}) for ${method} ${path}.`;
  }
}

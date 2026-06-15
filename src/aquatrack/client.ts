import type { Config } from "../config.js";
import type { Profile, Building } from "./types.js";

export class AquaTrackClient {
  constructor(
    private readonly cfg: Config,
    private readonly cookies: string[],
  ) {}

  static async authenticate(
    cfg: Config,
    email: string,
    password: string,
  ): Promise<{ cookies: string[]; profile?: Profile }> {
    const res = await fetch(`${cfg.aquatrackUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) {
      throw new Error(`Login failed with status: ${res.status}`);
    }

    const setCookie = res.headers.getSetCookie?.() ?? [];
    const cookies = setCookie.map((c) => c.split(";")[0]).filter(Boolean);

    let profile: Profile | undefined;
    try {
      const profRes = await fetch(`${cfg.aquatrackUrl}/api/v1/auth/profile`, {
        headers: { Cookie: cookies.join("; ") },
      });
      if (profRes.ok) profile = (await profRes.json()) as Profile;
    } catch {}

    return { cookies, profile };
  }

  async getBuildings(): Promise<Building[]> {
    return this.request("GET", "/api/v1/buildings");
  }

  private async request<T>(method: string, path: string): Promise<T> {
    const url = `${this.cfg.aquatrackUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Cookie: this.cookies.join("; "),
      },
    });

    if (!res.ok) {
      throw new Error(`API Error ${res.status} on ${method} ${path}`);
    }

    return (await res.json()) as T;
  }
}

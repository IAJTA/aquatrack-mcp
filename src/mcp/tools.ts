import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ServerRequest,
  ServerNotification,
} from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "../logger.js";
import type { SessionStore } from "../auth/sessions.js";
import {
  AquaTrackClient,
  ApiError,
  AuthExpiredError,
} from "../aquatrack/client.js";
import type { Apartment } from "../aquatrack/types.js";
import { bs, joinLines, m3, num, pct, result, round } from "./format.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

class ToolInputError extends Error {}

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;
const SAFE_TRIGGER = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const buildingArgs = {
  buildingId: z
    .string()
    .optional()
    .describe("Building UUID. Provide this OR buildingName."),
  buildingName: z
    .string()
    .optional()
    .describe(
      'Building name, e.g. "Universidad Católica" (case-insensitive, partial match allowed).',
    ),
};

const apartmentArgs = {
  apartmentId: z
    .string()
    .optional()
    .describe("Apartment UUID. Provide this OR apartmentNumber."),
  apartmentNumber: z
    .string()
    .optional()
    .describe('Apartment number, e.g. "101" or "Medidor 1".'),
  ...buildingArgs,
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUUID = (v: string) => UUID_RE.test(v);

export function registerAquaTrackTools(
  server: McpServer,
  sessions: SessionStore,
  logger: Logger,
): void {
  function resolveClient(extra: Extra): AquaTrackClient {
    const sessionId = extra.authInfo?.extra?.sessionId as string | undefined;
    if (!sessionId)
      throw new AuthExpiredError(
        "No authenticated AquaTrack session on this request.",
      );
    const session = sessions.get(sessionId);
    if (!session) throw new AuthExpiredError();
    return sessions.clientFor(session);
  }

  function errorResult(text: string) {
    return { content: [{ type: "text" as const, text }], isError: true };
  }

  function messageFor(e: unknown): string {
    if (e instanceof AuthExpiredError) {
      return "Your AquaTrack session has expired or is invalid. Please reconnect the AquaTrack connector to sign in again.";
    }
    if (e instanceof ToolInputError) return e.message;
    if (e instanceof ApiError) {
      return e.detail ? `${e.message}\nDetails: ${e.detail}` : e.message;
    }
    const msg = e instanceof Error ? e.message : String(e);
    return `Unexpected error: ${logger.redact(msg)}`;
  }

  const withClient =
    <A>(
      fn: (
        client: AquaTrackClient,
        args: A,
        extra: Extra,
      ) => Promise<ReturnType<typeof result>>,
    ) =>
    async (args: A, extra: Extra) => {
      let client: AquaTrackClient;
      try {
        client = resolveClient(extra);
      } catch (e) {
        return errorResult(messageFor(e));
      }
      try {
        return await fn(client, args, extra);
      } catch (e) {
        logger.warn("Tool execution failed", {
          reason: logger.redact(e instanceof Error ? e.message : String(e)),
        });
        return errorResult(messageFor(e));
      }
    };

  // Resolution helpers

  async function resolveBuildingId(
    client: AquaTrackClient,
    a: { buildingId?: string; buildingName?: string },
  ): Promise<string> {
    if (a.buildingId && isUUID(a.buildingId)) return a.buildingId;
    const name = a.buildingName ?? a.buildingId;
    if (!name)
      throw new ToolInputError(
        "Provide a buildingId (UUID) or a buildingName.",
      );
    const buildings = await client.getBuildings();
    const lower = name.toLowerCase();
    const match =
      buildings.find((b) => b.name.toLowerCase() === lower) ??
      buildings.find((b) => b.name.toLowerCase().includes(lower));
    if (!match) {
      const available =
        buildings.map((b) => `"${b.name}"`).join(", ") || "(none registered)";
      throw new ToolInputError(
        `Building "${name}" not found. Available buildings: ${available}.`,
      );
    }
    return match.id;
  }

  async function resolveApartment(
    client: AquaTrackClient,
    a: {
      apartmentId?: string;
      apartmentNumber?: string;
      buildingId?: string;
      buildingName?: string;
    },
  ): Promise<{ id: string; buildingId: string }> {
    if (a.apartmentId && isUUID(a.apartmentId)) {
      const apt = await client.getApartment(a.apartmentId);
      return { id: apt.id, buildingId: apt.buildingId };
    }
    const number = a.apartmentNumber ?? a.apartmentId;
    if (!number)
      throw new ToolInputError(
        "Provide an apartmentId (UUID) or an apartmentNumber.",
      );

    const role = client.profile?.role;
    if (role === "owner" || role === "tenant") {
      const mine = await myApartments(client);
      const m = mine.find(
        (ap) => ap.apartmentNumber.toLowerCase() === number.toLowerCase(),
      );
      if (m) return { id: m.id, buildingId: m.buildingId };
      throw new ToolInputError(
        `Apartment "${number}" not found among your apartments. Use my_apartments to see them.`,
      );
    }

    const buildingIds =
      a.buildingId || a.buildingName
        ? [await resolveBuildingId(client, a)]
        : (await client.getBuildings()).map((b) => b.id);
    for (const bId of buildingIds) {
      const apts = await client.getApartmentsByBuilding(bId);
      const m = apts.find(
        (e) =>
          e.apartment.apartmentNumber.toLowerCase() === number.toLowerCase(),
      );
      if (m) return { id: m.apartment.id, buildingId: m.apartment.buildingId };
    }
    throw new ToolInputError(
      `Apartment "${number}" not found. Use list_apartments to see available apartment numbers.`,
    );
  }

  async function myApartments(client: AquaTrackClient): Promise<Apartment[]> {
    const p = client.profile;
    if (!p)
      throw new ToolInputError(
        "Could not determine your account; please reconnect.",
      );
    if (p.role === "owner") return client.getApartmentsByOwner(p.id);
    if (p.role === "tenant") return client.getApartmentsByTenant(p.id);
    throw new ToolInputError(
      "You are an administrator: use list_apartments with a building, or get_building_overview.",
    );
  }

  // whoami

  server.registerTool(
    "whoami",
    {
      title: "Connection info",
      description:
        "Show which AquaTrack account this connection is authenticated as (email and role). Useful to confirm the connector is linked and to understand which tools the account can use.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    withClient(async (client) => {
      const p = client.profile;
      if (!p) {
        return result(
          "Connected to AquaTrack, but the account profile could not be read. Most read tools should still work.",
        );
      }
      const guidance =
        p.role === "admin" || p.role === "super_admin"
          ? "As an admin you can use all building/consumption tools — start with list_buildings or get_building_overview."
          : "As an owner/tenant, start with my_apartments to see your apartments and their consumption.";
      return result(
        joinLines([
          `Connected to AquaTrack as ${p.email} (role: ${p.role}).`,
          guidance,
        ]),
        { profile: p },
      );
    }),
  );

  // my_apartments (owner/tenant)

  server.registerTool(
    "my_apartments",
    {
      title: "My apartments",
      description:
        "For owners and tenants: list the apartments you own or rent, each with its building, latest meter reading and current daily consumption. (Admins should use list_buildings / list_apartments / get_building_overview instead.)",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    withClient(async (client) => {
      const p = client.profile;
      if (p && (p.role === "admin" || p.role === "super_admin")) {
        return result(
          "Your account is an administrator. Use `list_buildings`, then `list_apartments` or `get_building_overview` for a building.",
        );
      }
      const apts = await myApartments(client);
      if (apts.length === 0) {
        return result("You have no apartments assigned in AquaTrack.", {
          apartments: [],
        });
      }
      const enriched = await Promise.all(
        apts.map(async (ap) => {
          const [readingS, buildingS] = await Promise.allSettled([
            client.getWaterReading(ap.id),
            client.getBuilding(ap.buildingId),
          ]);
          return {
            apartment: ap,
            reading: readingS.status === "fulfilled" ? readingS.value : null,
            buildingName:
              buildingS.status === "fulfilled"
                ? buildingS.value.name
                : ap.buildingId,
          };
        }),
      );
      const lines = enriched.map(
        (e) =>
          `• #${e.apartment.apartmentNumber} — ${e.buildingName}` +
          (e.reading
            ? ` · reading ${round(e.reading.latestReading)}, daily ${m3(e.reading.dailyConsumption)}`
            : ""),
      );
      return result(
        joinLines([`You have ${apts.length} apartment(s):`, ...lines]),
        { apartments: enriched },
      );
    }),
  );

  // buildings

  server.registerTool(
    "list_buildings",
    {
      title: "List buildings",
      description:
        "List all buildings the authenticated administrator manages, with address, location and apartment count. Start here to discover building names/IDs for other tools.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    withClient(async (client) => {
      const buildings = await client.getBuildings();
      if (buildings.length === 0)
        return result("No buildings are registered for this account.", {
          buildings,
        });
      const lines = buildings.map(
        (b) =>
          `• ${b.name} — ${b.address}${b.addressNumber ? ` ${b.addressNumber}` : ""}, ${b.municipality}, ${b.department} · ${b.totalApartments} apartments`,
      );
      return result(joinLines([`${buildings.length} building(s):`, ...lines]), {
        buildings,
      });
    }),
  );

  server.registerTool(
    "get_building",
    {
      title: "Get building details",
      description:
        "Get details for one building by name or UUID (address, location, total apartments, floors).",
      inputSchema: { ...buildingArgs },
      annotations: READ_ONLY,
    },
    withClient(async (client, a: z.infer<z.ZodObject<typeof buildingArgs>>) => {
      const id = await resolveBuildingId(client, a);
      const b = await client.getBuilding(id);
      return result(
        joinLines([
          `${b.name}`,
          `Address: ${b.address}${b.addressNumber ? ` ${b.addressNumber}` : ""}${b.addressReference ? ` (${b.addressReference})` : ""}`,
          `Location: ${b.municipality}, ${b.department}`,
          `Apartments: ${b.totalApartments}${b.floors ? ` · Floors: ${b.floors}` : ""}`,
        ]),
        { building: b },
      );
    }),
  );

  // apartments

  server.registerTool(
    "list_apartments",
    {
      title: "List apartments in a building",
      description:
        "List every apartment in a building (by name or UUID), including floor, room count and the owner/tenant on record.",
      inputSchema: { ...buildingArgs },
      annotations: READ_ONLY,
    },
    withClient(async (client, a: z.infer<z.ZodObject<typeof buildingArgs>>) => {
      const id = await resolveBuildingId(client, a);
      const apts = await client.getApartmentsByBuilding(id);
      if (apts.length === 0)
        return result("This building has no registered apartments.", {
          buildingId: id,
          apartments: apts,
        });
      const lines = apts.map((e) => {
        const ap = e.apartment;
        const who = e.tenant?.name
          ? `tenant: ${e.tenant.name}`
          : e.owner?.name
            ? `owner: ${e.owner.name}`
            : "unoccupied";
        return `• #${ap.apartmentNumber} — floor ${ap.floor}${ap.roomsNumber ? `, ${ap.roomsNumber} rooms` : ""} · ${who}`;
      });
      return result(joinLines([`${apts.length} apartment(s):`, ...lines]), {
        buildingId: id,
        apartments: apts,
      });
    }),
  );

  server.registerTool(
    "get_apartment",
    {
      title: "Get apartment + latest reading",
      description:
        "Get one apartment's details (by number+building or UUID) together with its latest water-meter reading and current daily consumption.",
      inputSchema: { ...apartmentArgs },
      annotations: READ_ONLY,
    },
    withClient(
      async (client, a: z.infer<z.ZodObject<typeof apartmentArgs>>) => {
        const { id } = await resolveApartment(client, a);
        const [apt, readingSettled] = await Promise.all([
          client.getApartment(id),
          client.getWaterReading(id).then(
            (r) => ({ ok: true as const, r }),
            () => ({ ok: false as const }),
          ),
        ]);
        const reading = readingSettled.ok ? readingSettled.r : null;
        return result(
          joinLines([
            `Apartment #${apt.apartmentNumber} (floor ${apt.floor})`,
            apt.roomsNumber ? `Rooms: ${apt.roomsNumber}` : undefined,
            reading
              ? `Latest meter reading: ${round(reading.latestReading)}`
              : "Latest meter reading: unavailable",
            reading
              ? `Daily consumption: ${m3(reading.dailyConsumption)}`
              : undefined,
          ]),
          { apartment: apt, reading },
        );
      },
    ),
  );

  server.registerTool(
    "get_apartment_consumption_history",
    {
      title: "Apartment daily history",
      description:
        "Get the last ~30 days of daily water consumption for one apartment, with total / average / peak-day summary. Good for spotting leaks or unusual usage.",
      inputSchema: { ...apartmentArgs },
      annotations: READ_ONLY,
    },
    withClient(
      async (client, a: z.infer<z.ZodObject<typeof apartmentArgs>>) => {
        const { id } = await resolveApartment(client, a);
        const history = await client.getApartmentDailyHistory(id);
        if (history.length === 0)
          return result(
            "No daily consumption recorded for this apartment yet.",
            { apartmentId: id, history },
          );
        const values = history.map((h) => num(h.consumption));
        const total = values.reduce((s, v) => s + v, 0);
        const peak = history.reduce((mx, h) =>
          num(h.consumption) > num(mx.consumption) ? h : mx,
        );
        const summary = {
          days: history.length,
          total: round(total),
          average: round(total / history.length),
          peakDate: peak.date,
          peakConsumption: round(peak.consumption),
        };
        const recent = history
          .slice(-7)
          .map((h) => `  ${h.date}: ${m3(h.consumption)}`);
        return result(
          joinLines([
            `Daily consumption — ${summary.days} days`,
            `Total: ${m3(summary.total)} · Avg/day: ${m3(summary.average)} · Peak: ${m3(summary.peakConsumption)} on ${summary.peakDate}`,
            "Last 7 days:",
            ...recent,
          ]),
          { apartmentId: id, summary, history },
        );
      },
    ),
  );

  // building_overview

  server.registerTool(
    "get_building_overview",
    {
      title: "Building water overview",
      description:
        "One-shot situational summary for a building: today's total consumption, the day-over-day change %, the top water consumers from yesterday, and IoT gateway (central) status. The fastest way to answer 'how is building X doing?'.",
      inputSchema: {
        ...buildingArgs,
        topLimit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("How many top consumers to include (default 5)."),
      },
      annotations: READ_ONLY,
    },
    withClient(
      async (
        client,
        a: { buildingId?: string; buildingName?: string; topLimit?: number },
      ) => {
        const id = await resolveBuildingId(client, a);
        const limit = a.topLimit ?? 5;
        const [building, daily, change, top, centrals] =
          await Promise.allSettled([
            client.getBuilding(id),
            client.getBuildingDaily(id),
            client.getBuildingDailyChange(id),
            client.getTopConsumers(id, limit),
            client.getCentralsByBuilding(id),
          ]);

        const name = building.status === "fulfilled" ? building.value.name : id;
        const lines: (string | undefined)[] = [`Overview — ${name}`];

        if (daily.status === "fulfilled" && daily.value) {
          lines.push(
            `Today's consumption: ${m3(daily.value.consumption)} (as of ${daily.value.date})`,
          );
        } else {
          lines.push("Today's consumption: not yet calculated.");
        }
        if (change.status === "fulfilled" && change.value) {
          lines.push(
            `Day-over-day change: ${pct(change.value.changePercentage)}`,
          );
        }
        if (top.status === "fulfilled" && top.value.length > 0) {
          lines.push(`Top ${top.value.length} consumers yesterday:`);
          top.value.forEach((c, i) =>
            lines.push(
              `  ${i + 1}. #${c.apartmentNumber} (${c.username}) — ${m3(c.totalConsumption)}`,
            ),
          );
        }
        if (centrals.status === "fulfilled") {
          const active = centrals.value.filter((c) => c.isActive).length;
          lines.push(
            `IoT gateways (centrals): ${active}/${centrals.value.length} active`,
          );
        }

        return result(joinLines(lines), {
          buildingId: id,
          building: building.status === "fulfilled" ? building.value : null,
          today: daily.status === "fulfilled" ? daily.value : null,
          changePercentage:
            change.status === "fulfilled"
              ? (change.value?.changePercentage ?? null)
              : null,
          topConsumers: top.status === "fulfilled" ? top.value : [],
          centrals: centrals.status === "fulfilled" ? centrals.value : [],
        });
      },
    ),
  );

  server.registerTool(
    "get_top_consumers",
    {
      title: "Top consumers (yesterday)",
      description:
        "Rank the apartments with the highest water consumption yesterday in a building. Useful for leak detection, fair-use checks and tenant outreach.",
      inputSchema: {
        ...buildingArgs,
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Number of apartments to rank (default 5)."),
      },
      annotations: READ_ONLY,
    },
    withClient(
      async (
        client,
        a: { buildingId?: string; buildingName?: string; limit?: number },
      ) => {
        const id = await resolveBuildingId(client, a);
        const limit = a.limit ?? 5;
        const top = await client.getTopConsumers(id, limit);
        if (top.length === 0)
          return result("No consumption data for yesterday in this building.", {
            buildingId: id,
            topConsumers: top,
          });
        const lines = top.map(
          (c, i) =>
            `${i + 1}. #${c.apartmentNumber} (${c.username}) — ${m3(c.totalConsumption)}`,
        );
        return result(
          joinLines([`Top ${top.length} consumers yesterday:`, ...lines]),
          { buildingId: id, topConsumers: top },
        );
      },
    ),
  );

  server.registerTool(
    "get_building_billing",
    {
      title: "Building billing history",
      description:
        "Monthly water consumption (m³) and the corresponding payment/bill (Bs) for a building, plus average and peak daily usage per month. Use to review billing trends.",
      inputSchema: {
        ...buildingArgs,
        months: z
          .number()
          .int()
          .min(1)
          .max(24)
          .optional()
          .describe("How many recent months to return (default 12, max 24)."),
      },
      annotations: READ_ONLY,
    },
    withClient(
      async (
        client,
        a: { buildingId?: string; buildingName?: string; months?: number },
      ) => {
        const id = await resolveBuildingId(client, a);
        const rows = await client.getBuildingMonthly(id, {
          months: a.months ?? 12,
        });
        if (rows.length === 0)
          return result("No monthly billing data found for this building.", {
            buildingId: id,
            months: rows,
          });
        const sorted = [...rows].sort((x, y) => x.month.localeCompare(y.month));
        const totalPaid = sorted.reduce((s, r) => s + num(r.payment), 0);
        const totalM3 = sorted.reduce((s, r) => s + num(r.consumption), 0);
        const lines = sorted.map(
          (r) =>
            `• ${r.month}: ${m3(r.consumption)} → ${bs(r.payment)} (avg ${m3(r.avgDailyUsage)}/day, peak ${m3(r.peakDayUsage)})`,
        );
        return result(
          joinLines([
            `Billing — ${sorted.length} month(s)`,
            ...lines,
            `Totals: ${m3(totalM3)} · ${bs(totalPaid)}`,
          ]),
          {
            buildingId: id,
            months: sorted,
            totals: { consumption: round(totalM3), payment: round(totalPaid) },
          },
        );
      },
    ),
  );

  server.registerTool(
    "get_building_daily_change",
    {
      title: "Building daily change %",
      description:
        "Get the percentage change in a building's total water consumption between yesterday and the day before. A large spike can indicate a leak or event.",
      inputSchema: { ...buildingArgs },
      annotations: READ_ONLY,
    },
    withClient(async (client, a: z.infer<z.ZodObject<typeof buildingArgs>>) => {
      const id = await resolveBuildingId(client, a);
      const change = await client.getBuildingDailyChange(id);
      return result(
        `Day-over-day consumption change: ${pct(change.changePercentage)}.`,
        {
          buildingId: id,
          changePercentage: change.changePercentage,
        },
      );
    }),
  );

  // centrals

  server.registerTool(
    "list_centrals",
    {
      title: "List IoT gateways (centrals)",
      description:
        "List the central gateway devices installed in a building and whether each is active, including Wi-Fi SSID, MAC and install date. Use to check device/connectivity health.",
      inputSchema: { ...buildingArgs },
      annotations: READ_ONLY,
    },
    withClient(async (client, a: z.infer<z.ZodObject<typeof buildingArgs>>) => {
      const id = await resolveBuildingId(client, a);
      const centrals = await client.getCentralsByBuilding(id);
      if (centrals.length === 0)
        return result("No central gateways are registered for this building.", {
          buildingId: id,
          centrals,
        });
      const active = centrals.filter((c) => c.isActive).length;
      const lines = centrals.map(
        (c) =>
          `• Central ${c.id} — ${c.isActive ? "🟢 active" : "🔴 inactive"}${c.wifiSsid ? ` · Wi-Fi: ${c.wifiSsid}` : ""}${c.macAddress ? ` · MAC: ${c.macAddress}` : ""}`,
      );
      return result(
        joinLines([
          `${active}/${centrals.length} gateway(s) active:`,
          ...lines,
        ]),
        { buildingId: id, centrals },
      );
    }),
  );

  // water_meters

  server.registerTool(
    "list_water_meters",
    {
      title: "List water meters (health)",
      description:
        "List all IoT water meters with battery level, active state and MAC address, flagging low-battery (< 3.5 V) and inactive meters. NOTE: requires the 'super_admin' role; other roles will get a permission error.",
      inputSchema: {
        lowBatteryThreshold: z
          .number()
          .min(0)
          .max(5)
          .optional()
          .describe(
            "Battery voltage below which a meter is flagged (default 3.5).",
          ),
      },
      annotations: READ_ONLY,
    },
    withClient(async (client, a: { lowBatteryThreshold?: number }) => {
      const threshold = a.lowBatteryThreshold ?? 3.5;
      const meters = await client.getWaterMeters();
      const lowBattery = meters.filter((mtr) => num(mtr.battery) < threshold);
      const inactive = meters.filter((mtr) => !mtr.isActive);
      const lines = [
        `${meters.length} meter(s): ${meters.length - inactive.length} active, ${inactive.length} inactive.`,
        `${lowBattery.length} meter(s) below ${threshold} V battery.`,
      ];
      if (lowBattery.length > 0) {
        lines.push("Low battery:");
        lowBattery.forEach((mtr) =>
          lines.push(
            `  • ${mtr.id} — ${round(mtr.battery, 2)} V${mtr.apartmentId ? ` (apt ${mtr.apartmentId})` : " (unassigned)"}`,
          ),
        );
      }
      return result(joinLines(lines), {
        summary: {
          total: meters.length,
          inactive: inactive.length,
          lowBattery: lowBattery.length,
          threshold,
        },
        meters,
      });
    }),
  );

  // recalculate_consumption

  server.registerTool(
    "recalculate_consumption",
    {
      title: "Recalculate today's consumption",
      description:
        "Safely re-run AquaTrack's daily consumption roll-up from the raw meter readings (normally scheduled automatically). Idempotent: it recomputes derived totals only and never creates, edits or deletes buildings, apartments, users or bills. Requires the 'admin' role.",
      inputSchema: {
        scope: z
          .enum(["all", "buildings", "apartments"])
          .optional()
          .describe(
            "Which roll-up to recompute: 'buildings', 'apartments', or 'all' (default).",
          ),
      },
      annotations: SAFE_TRIGGER,
    },
    withClient(
      async (client, a: { scope?: "all" | "buildings" | "apartments" }) => {
        const scope = a.scope ?? "all";
        const out: Record<string, unknown> = {};
        const lines: string[] = [];
        if (scope === "all" || scope === "buildings") {
          const r = await client.recalculateBuildingDaily();
          out.buildings = r;
          lines.push(`Buildings: ${r.message ?? "recalculated"}`);
        }
        if (scope === "all" || scope === "apartments") {
          const r = await client.recalculateApartmentsDaily();
          out.apartments = r;
          lines.push(`Apartments: ${r.message ?? "recalculated"}`);
        }
        return result(
          joinLines(["Daily consumption recalculation triggered.", ...lines]),
          out,
        );
      },
    ),
  );
}

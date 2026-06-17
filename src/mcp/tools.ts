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
        "Get one apartment's details (by number+building or UUID) together with its latest water-meter reading and current daily consumption. (Do not use this if you only need the historical monthly consumption).",
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
        "Get the last ~30 days of daily water consumption for one apartment (by number+building or UUID), with total / average / peak-day summary. Good for spotting leaks or unusual usage. (No need to call get_apartment first).",
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

  // Analytical tools

  server.registerTool(
    "analyze_building_consumption",
    {
      title: "Analyze building consumption",
      description:
        "Deep analysis of a building's water consumption: today's usage, day-over-day change, 6-month trend (rising/falling/stable), average monthly cost per m³. Use to understand consumption patterns and cost efficiency. (Do not call get_building_billing to supplement this analysis if data is missing, as they share the same data source).",
      inputSchema: { ...buildingArgs },
      annotations: READ_ONLY,
    },
    withClient(async (client, a: z.infer<z.ZodObject<typeof buildingArgs>>) => {
      const id = await resolveBuildingId(client, a);
      const [buildingS, dailyS, changeS, monthlyS] = await Promise.allSettled([
        client.getBuilding(id),
        client.getBuildingDaily(id),
        client.getBuildingDailyChange(id),
        client.getBuildingMonthly(id, { months: 6 }),
      ]);

      const name = buildingS.status === "fulfilled" ? buildingS.value.name : id;
      const lines: (string | undefined)[] = [
        `📊 Consumption Analysis — ${name}`,
      ];

      // Today
      if (dailyS.status === "fulfilled" && dailyS.value) {
        lines.push(
          `Today: ${m3(dailyS.value.consumption)} (${dailyS.value.date})`,
        );
      }
      if (changeS.status === "fulfilled" && changeS.value) {
        lines.push(
          `Day-over-day change: ${pct(changeS.value.changePercentage)}`,
        );
      }

      // Monthly analysis
      let trend: string | undefined;
      const monthlyData: typeof monthlyS extends PromiseSettledResult<infer T>
        ? T
        : never = monthlyS.status === "fulfilled" ? monthlyS.value : [];

      if (Array.isArray(monthlyData) && monthlyData.length >= 2) {
        const sorted = [...monthlyData].sort((a, b) =>
          a.month.localeCompare(b.month),
        );
        const totalConsumption = sorted.reduce(
          (s, r) => s + num(r.consumption),
          0,
        );
        const totalPayment = sorted.reduce((s, r) => s + num(r.payment), 0);
        const avgMonthly = totalConsumption / sorted.length;
        const costPerM3 =
          totalConsumption > 0 ? totalPayment / totalConsumption : 0;

        const peak = sorted.reduce((mx, r) =>
          num(r.consumption) > num(mx.consumption) ? r : mx,
        );
        const min = sorted.reduce((mn, r) =>
          num(r.consumption) < num(mn.consumption) ? r : mn,
        );

        // Compare last 3 months vs first 3
        if (sorted.length >= 4) {
          const half = Math.floor(sorted.length / 2);
          const firstHalf =
            sorted.slice(0, half).reduce((s, r) => s + num(r.consumption), 0) /
            half;
          const secondHalf =
            sorted.slice(half).reduce((s, r) => s + num(r.consumption), 0) /
            (sorted.length - half);
          const changePct =
            firstHalf > 0 ? ((secondHalf - firstHalf) / firstHalf) * 100 : 0;
          trend =
            changePct > 10
              ? `📈 RISING (+${round(changePct, 1)}%)`
              : changePct < -10
                ? `📉 FALLING (${round(changePct, 1)}%)`
                : `➡️ STABLE (${round(changePct, 1)}%)`;
        }

        lines.push("");
        lines.push(`${sorted.length}-month summary:`);
        lines.push(
          `  Avg/month: ${m3(avgMonthly)} · Cost/m³: ${bs(costPerM3)}`,
        );
        lines.push(
          `  Peak: ${m3(peak.consumption)} (${peak.month}) · Min: ${m3(min.consumption)} (${min.month})`,
        );
        lines.push(`  Total: ${m3(totalConsumption)} · ${bs(totalPayment)}`);
        if (trend) lines.push(`  Trend: ${trend}`);
      } else {
        lines.push("Not enough monthly data for trend analysis.");
      }

      return result(joinLines(lines), {
        buildingId: id,
        today: dailyS.status === "fulfilled" ? dailyS.value : null,
        changePercentage:
          changeS.status === "fulfilled"
            ? (changeS.value?.changePercentage ?? null)
            : null,
        monthly: Array.isArray(monthlyData) ? monthlyData : [],
        trend: trend ?? null,
      });
    }),
  );

  server.registerTool(
    "detect_potential_leaks",
    {
      title: "Detect potential leaks",
      description:
        "Analyzes daily consumption data for each apartment in a building to detect statistical anomalies that may indicate water leaks. Flags apartments where current consumption is significantly above their historical average (>2 standard deviations). Also flags unoccupied apartments with non-zero consumption.",
      inputSchema: {
        ...buildingArgs,
        maxApartments: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe(
            "Max apartments to analyze (default 20). If the prompt implies checking 'any' or 'all' apartments, explicitly provide a high value like 100 to ensure full coverage.",
          ),
      },
      annotations: READ_ONLY,
    },
    withClient(
      async (
        client,
        a: {
          buildingId?: string;
          buildingName?: string;
          maxApartments?: number;
        },
      ) => {
        const id = await resolveBuildingId(client, a);
        const limit = a.maxApartments ?? 20;
        const apts = await client.getApartmentsByBuilding(id);

        // Analyze top consumers
        const topConsumers = await client.getTopConsumers(id, limit);
        const topIds = new Set(topConsumers.map((c) => c.apartmentId));
        const toAnalyze = apts
          .filter((e) => topIds.has(e.apartment.id))
          .concat(apts.filter((e) => !topIds.has(e.apartment.id)))
          .slice(0, limit);

        interface LeakRisk {
          apartmentNumber: string;
          apartmentId: string;
          risk: "HIGH" | "MEDIUM" | "LOW";
          reason: string;
          currentConsumption: number;
          avgConsumption: number;
          stdDev: number;
        }

        const risks: LeakRisk[] = [];
        await Promise.allSettled(
          toAnalyze.map(async (e) => {
            const apt = e.apartment;
            const [historyS, readingS] = await Promise.allSettled([
              client.getApartmentDailyHistory(apt.id),
              client.getWaterReading(apt.id),
            ]);

            const history =
              historyS.status === "fulfilled" ? historyS.value : [];
            const reading =
              readingS.status === "fulfilled" ? readingS.value : null;

            if (history.length < 7) return; // not enough data

            const values = history.map((h) => num(h.consumption));
            const mean = values.reduce((s, v) => s + v, 0) / values.length;
            const variance =
              values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
            const stdDev = Math.sqrt(variance);
            const current = reading ? num(reading.dailyConsumption) : 0;

            if (!e.tenant && !e.owner && current > 0) {
              risks.push({
                apartmentNumber: apt.apartmentNumber,
                apartmentId: apt.id,
                risk: "HIGH",
                reason: `Unoccupied apartment with active consumption (${m3(current)}/day)`,
                currentConsumption: round(current),
                avgConsumption: round(mean),
                stdDev: round(stdDev),
              });
              return;
            }

            if (stdDev > 0 && current > mean + 3 * stdDev) {
              risks.push({
                apartmentNumber: apt.apartmentNumber,
                apartmentId: apt.id,
                risk: "HIGH",
                reason: `Consumption ${m3(current)} is >3σ above avg ${m3(mean)}`,
                currentConsumption: round(current),
                avgConsumption: round(mean),
                stdDev: round(stdDev),
              });
            } else if (stdDev > 0 && current > mean + 2 * stdDev) {
              risks.push({
                apartmentNumber: apt.apartmentNumber,
                apartmentId: apt.id,
                risk: "MEDIUM",
                reason: `Consumption ${m3(current)} is >2σ above avg ${m3(mean)}`,
                currentConsumption: round(current),
                avgConsumption: round(mean),
                stdDev: round(stdDev),
              });
            } else if (stdDev > 0 && current > mean + 1.5 * stdDev) {
              risks.push({
                apartmentNumber: apt.apartmentNumber,
                apartmentId: apt.id,
                risk: "LOW",
                reason: `Consumption ${m3(current)} is >1.5σ above avg ${m3(mean)}`,
                currentConsumption: round(current),
                avgConsumption: round(mean),
                stdDev: round(stdDev),
              });
            }
          }),
        );

        const lines: string[] = [
          `🔍 Leak Detection — ${apts.length} apartments, ${toAnalyze.length} analyzed`,
        ];

        if (risks.length === 0) {
          lines.push(
            "✅ No potential leaks detected. All apartments are within normal consumption ranges.",
          );
        } else {
          risks.sort((a, b) => {
            const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
            return order[a.risk] - order[b.risk];
          });
          const emoji = { HIGH: "🔴", MEDIUM: "🟡", LOW: "🟠" };
          lines.push(`⚠️ ${risks.length} apartment(s) flagged:`);
          for (const r of risks) {
            lines.push(
              `  ${emoji[r.risk]} ${r.risk} — #${r.apartmentNumber}: ${r.reason}`,
            );
          }
        }

        return result(joinLines(lines), {
          buildingId: id,
          totalApartments: apts.length,
          analyzed: toAnalyze.length,
          risks,
        });
      },
    ),
  );

  server.registerTool(
    "generate_executive_summary",
    {
      title: "Executive summary",
      description:
        "Generates a comprehensive executive summary for a building: overall status rating (🟢/🟡/🔴), today's consumption with trend, 3-month billing trend, top consumers, IoT gateway health, and key alerts. Ideal for a quick management briefing.",
      inputSchema: { ...buildingArgs },
      annotations: READ_ONLY,
    },
    withClient(async (client, a: z.infer<z.ZodObject<typeof buildingArgs>>) => {
      const id = await resolveBuildingId(client, a);
      const [buildingS, dailyS, changeS, monthlyS, topS, centralsS] =
        await Promise.allSettled([
          client.getBuilding(id),
          client.getBuildingDaily(id),
          client.getBuildingDailyChange(id),
          client.getBuildingMonthly(id, { months: 3 }),
          client.getTopConsumers(id, 5),
          client.getCentralsByBuilding(id),
        ]);

      const name = buildingS.status === "fulfilled" ? buildingS.value.name : id;
      const building =
        buildingS.status === "fulfilled" ? buildingS.value : null;

      const alerts: string[] = [];
      let statusScore = 0;

      const changePct =
        changeS.status === "fulfilled"
          ? (changeS.value?.changePercentage ?? 0)
          : 0;
      if (Math.abs(changePct) > 30) {
        alerts.push(`Large day-over-day change: ${pct(changePct)}`);
        statusScore -= 2;
      } else if (Math.abs(changePct) > 15) {
        statusScore -= 1;
      }

      const centrals = centralsS.status === "fulfilled" ? centralsS.value : [];
      const inactiveCentrals = centrals.filter((c) => !c.isActive);
      if (inactiveCentrals.length > 0) {
        alerts.push(`${inactiveCentrals.length} IoT gateway(s) inactive`);
        statusScore -= inactiveCentrals.length;
      }

      const statusEmoji =
        statusScore >= 0 ? "🟢" : statusScore >= -2 ? "🟡" : "🔴";
      const statusLabel =
        statusScore >= 0
          ? "Good"
          : statusScore >= -2
            ? "Needs Attention"
            : "Critical";

      const lines: (string | undefined)[] = [
        `📋 Executive Summary — ${name}`,
        `Status: ${statusEmoji} ${statusLabel}`,
        "",
      ];

      // Today
      if (dailyS.status === "fulfilled" && dailyS.value) {
        lines.push(
          `Today: ${m3(dailyS.value.consumption)} (change: ${pct(changePct)})`,
        );
      }

      // Billing trend
      const monthly = monthlyS.status === "fulfilled" ? monthlyS.value : [];
      if (monthly.length > 0) {
        const sorted = [...monthly].sort((a, b) =>
          a.month.localeCompare(b.month),
        );
        lines.push("");
        lines.push("Billing (last 3 months):");
        for (const r of sorted) {
          lines.push(`  ${r.month}: ${m3(r.consumption)} → ${bs(r.payment)}`);
        }
      }

      // Top consumers
      const top = topS.status === "fulfilled" ? topS.value : [];
      if (top.length > 0) {
        lines.push("");
        lines.push("Top consumers yesterday:");
        top.forEach((c, i) =>
          lines.push(
            `  ${i + 1}. #${c.apartmentNumber} (${c.username}) — ${m3(c.totalConsumption)}`,
          ),
        );
      }

      // IoT status
      if (centrals.length > 0) {
        const active = centrals.filter((c) => c.isActive).length;
        lines.push("");
        lines.push(`IoT: ${active}/${centrals.length} gateways active`);
      }

      // Alerts
      if (alerts.length > 0) {
        lines.push("");
        lines.push("⚠️ Alerts:");
        alerts.forEach((a) => lines.push(`  • ${a}`));
      }

      return result(joinLines(lines), {
        buildingId: id,
        building,
        status: statusLabel,
        alerts,
        today: dailyS.status === "fulfilled" ? dailyS.value : null,
        changePercentage: changePct,
        monthly,
        topConsumers: top,
        centrals,
      });
    }),
  );

  server.registerTool(
    "compare_periods",
    {
      title: "Compare consumption periods",
      description:
        "Compare two months of building water consumption side-by-side: total consumption, average daily usage, peak day, and payment. Shows absolute and percentage differences. Use for month-over-month analysis. (If the user asks for the broader impact on billing, also call get_building_billing).",
      inputSchema: {
        ...buildingArgs,
        month1: z
          .string()
          .describe(
            "First month to compare, in YYYY-MM format (e.g. '2026-05'). Assume 2026 if no year is provided.",
          ),
        month2: z
          .string()
          .describe(
            "Second month to compare, in YYYY-MM format (e.g. '2026-06'). Assume 2026 if no year is provided.",
          ),
      },
      annotations: READ_ONLY,
    },
    withClient(
      async (
        client,
        a: {
          buildingId?: string;
          buildingName?: string;
          month1: string;
          month2: string;
        },
      ) => {
        const id = await resolveBuildingId(client, a);

        // Fetch both months in one call if possible
        const months = [a.month1, a.month2].sort();
        const data = await client.getBuildingMonthly(id, {
          startMonth: months[0],
          endMonth: months[1],
        });

        const m1 = data.find((r) => r.month === a.month1);
        const m2 = data.find((r) => r.month === a.month2);

        if (!m1 && !m2) {
          return result(
            `No consumption data found for either ${a.month1} or ${a.month2}.`,
            { buildingId: id },
          );
        }

        const lines: string[] = [
          `📊 Period Comparison — ${a.month1} vs ${a.month2}`,
          "",
        ];

        const formatRow = (
          label: string,
          v1: number | null,
          v2: number | null,
          fmt: (v: unknown) => string,
        ) => {
          const s1 = v1 !== null ? fmt(v1) : "N/A";
          const s2 = v2 !== null ? fmt(v2) : "N/A";
          let diff = "";
          if (v1 !== null && v2 !== null && v1 !== 0) {
            const pctChange = ((v2 - v1) / v1) * 100;
            diff = ` (${pct(pctChange)})`;
          }
          return `  ${label}: ${s1} → ${s2}${diff}`;
        };

        lines.push(
          formatRow(
            "Consumption",
            m1 ? num(m1.consumption) : null,
            m2 ? num(m2.consumption) : null,
            m3,
          ),
        );
        lines.push(
          formatRow(
            "Payment",
            m1 ? num(m1.payment) : null,
            m2 ? num(m2.payment) : null,
            bs,
          ),
        );
        lines.push(
          formatRow(
            "Avg daily",
            m1 ? num(m1.avgDailyUsage) : null,
            m2 ? num(m2.avgDailyUsage) : null,
            m3,
          ),
        );
        lines.push(
          formatRow(
            "Peak day",
            m1 ? num(m1.peakDayUsage) : null,
            m2 ? num(m2.peakDayUsage) : null,
            m3,
          ),
        );

        // Significance
        if (m1 && m2) {
          const pctChange =
            num(m1.consumption) > 0
              ? ((num(m2.consumption) - num(m1.consumption)) /
                  num(m1.consumption)) *
                100
              : 0;
          lines.push("");
          if (Math.abs(pctChange) > 20) {
            lines.push(
              `⚠️ Significant change: ${round(pctChange, 1)}% — warrants investigation.`,
            );
          } else if (Math.abs(pctChange) > 10) {
            lines.push(
              `📌 Notable change: ${round(pctChange, 1)}% — worth monitoring.`,
            );
          } else {
            lines.push(
              `✅ Consumption is stable between both periods (${round(pctChange, 1)}%).`,
            );
          }
        }

        return result(joinLines(lines), {
          buildingId: id,
          month1: m1 ?? null,
          month2: m2 ?? null,
        });
      },
    ),
  );

  server.registerTool(
    "find_high_risk_apartments",
    {
      title: "Find high-risk apartments",
      description:
        "Identifies apartments that pose the highest risk for water waste or leaks: consistently high consumers, unoccupied units with active consumption, and apartments with recent usage spikes. Returns a risk score and recommendation for each flagged apartment.",
      inputSchema: { ...buildingArgs },
      annotations: READ_ONLY,
    },
    withClient(async (client, a: z.infer<z.ZodObject<typeof buildingArgs>>) => {
      const id = await resolveBuildingId(client, a);
      const [apts, topConsumers] = await Promise.all([
        client.getApartmentsByBuilding(id),
        client.getTopConsumers(id, 50),
      ]);

      interface RiskEntry {
        apartmentNumber: string;
        apartmentId: string;
        score: number;
        flags: string[];
        recommendation: string;
      }

      const riskEntries: RiskEntry[] = [];
      const topMap = new Map(topConsumers.map((c) => [c.apartmentId, c]));

      // Calculate average consumption from top consumers
      const avgConsumption =
        topConsumers.length > 0
          ? topConsumers.reduce((s, c) => s + num(c.totalConsumption), 0) /
            topConsumers.length
          : 0;
      const p80Threshold = avgConsumption * 1.5;

      // Analyze top 15 consumers in detail
      const topToAnalyze = topConsumers.slice(0, 15);
      const histories = await Promise.allSettled(
        topToAnalyze.map((c) => client.getApartmentDailyHistory(c.apartmentId)),
      );

      for (let i = 0; i < topToAnalyze.length; i++) {
        const consumer = topToAnalyze[i];
        const aptInfo = apts.find(
          (e) => e.apartment.id === consumer.apartmentId,
        );
        const flags: string[] = [];
        let score = 0;

        // High consumer
        if (num(consumer.totalConsumption) > p80Threshold) {
          flags.push(
            `Top consumer: ${m3(consumer.totalConsumption)}/day (avg: ${m3(avgConsumption)})`,
          );
          score += 30;
        }

        // Unoccupied with consumption
        if (
          aptInfo &&
          !aptInfo.tenant &&
          !aptInfo.owner &&
          num(consumer.totalConsumption) > 0
        ) {
          flags.push("Unoccupied but consuming water");
          score += 50;
        }

        // Recent spike
        const histResult = histories[i];
        if (histResult.status === "fulfilled" && histResult.value.length >= 7) {
          const hist = histResult.value;
          const recent3 = hist.slice(-3);
          const older = hist.slice(0, -3);
          if (older.length > 0) {
            const olderAvg =
              older.reduce((s, h) => s + num(h.consumption), 0) / older.length;
            const recentAvg =
              recent3.reduce((s, h) => s + num(h.consumption), 0) /
              recent3.length;
            if (olderAvg > 0 && recentAvg > olderAvg * 2) {
              flags.push(
                `Recent spike: ${m3(recentAvg)}/day vs prior avg ${m3(olderAvg)}/day`,
              );
              score += 40;
            }
          }
        }

        if (flags.length > 0) {
          const recommendation =
            score >= 50
              ? "Urgent: inspect for leaks or unauthorized usage"
              : score >= 30
                ? "Monitor closely and notify tenant/owner"
                : "Track over the next week";

          riskEntries.push({
            apartmentNumber: consumer.apartmentNumber,
            apartmentId: consumer.apartmentId,
            score,
            flags,
            recommendation,
          });
        }
      }

      riskEntries.sort((a, b) => b.score - a.score);

      const lines: string[] = [
        `🎯 High-Risk Apartments — ${apts.length} total, ${topToAnalyze.length} analyzed`,
      ];

      if (riskEntries.length === 0) {
        lines.push("✅ No high-risk apartments detected.");
      } else {
        lines.push(`${riskEntries.length} apartment(s) flagged:`);
        for (const r of riskEntries) {
          const emoji = r.score >= 50 ? "🔴" : r.score >= 30 ? "🟡" : "🟠";
          lines.push(
            `  ${emoji} #${r.apartmentNumber} (risk: ${r.score}) — ${r.flags.join("; ")}`,
          );
          lines.push(`     → ${r.recommendation}`);
        }
      }

      return result(joinLines(lines), {
        buildingId: id,
        totalApartments: apts.length,
        risks: riskEntries,
      });
    }),
  );

  server.registerTool(
    "identify_consumption_anomalies",
    {
      title: "Identify consumption anomalies",
      description:
        "Statistical anomaly detection on a building's monthly consumption history: identifies months where consumption was significantly above or below the historical average (>2σ). Also analyzes per-apartment consumption for a specific month to find outliers.",
      inputSchema: {
        ...buildingArgs,
        month: z
          .string()
          .optional()
          .describe(
            "Month to analyze at apartment level (YYYY-MM). Defaults to last month.",
          ),
      },
      annotations: READ_ONLY,
    },
    withClient(
      async (
        client,
        a: {
          buildingId?: string;
          buildingName?: string;
          month?: string;
        },
      ) => {
        const id = await resolveBuildingId(client, a);
        const monthly = await client.getBuildingMonthly(id, { months: 12 });

        const lines: string[] = ["🔎 Anomaly Detection"];

        interface Anomaly {
          type: "building_month" | "apartment";
          label: string;
          value: number;
          mean: number;
          deviation: number;
          severity: "HIGH" | "MEDIUM";
        }

        const anomalies: Anomaly[] = [];

        // Building-level monthly anomalies
        if (monthly.length >= 3) {
          const sorted = [...monthly].sort((a, b) =>
            a.month.localeCompare(b.month),
          );
          const values = sorted.map((r) => num(r.consumption));
          const mean = values.reduce((s, v) => s + v, 0) / values.length;
          const variance =
            values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
          const stdDev = Math.sqrt(variance);

          lines.push("");
          lines.push(
            `Building monthly: avg ${m3(mean)}, σ ${m3(stdDev)} (${sorted.length} months)`,
          );

          for (const r of sorted) {
            const val = num(r.consumption);
            if (stdDev > 0 && Math.abs(val - mean) > 2 * stdDev) {
              const severity =
                Math.abs(val - mean) > 3 * stdDev ? "HIGH" : "MEDIUM";
              const dir = val > mean ? "above" : "below";
              anomalies.push({
                type: "building_month",
                label: r.month,
                value: round(val),
                mean: round(mean),
                deviation: round((val - mean) / stdDev, 1),
                severity,
              });
              lines.push(
                `  ${severity === "HIGH" ? "🔴" : "🟡"} ${r.month}: ${m3(val)} — ${round(Math.abs(val - mean) / stdDev, 1)}σ ${dir} average`,
              );
            }
          }
          if (!anomalies.some((a) => a.type === "building_month")) {
            lines.push("  ✅ All months within normal range.");
          }
        } else {
          lines.push("Not enough monthly data for building-level analysis.");
        }

        // Apartment-level for specific month
        const targetMonth =
          a.month ??
          (monthly.length > 0
            ? [...monthly].sort((a, b) => b.month.localeCompare(a.month))[0]
                .month
            : null);

        if (targetMonth) {
          try {
            const aptMonthly = await client.getApartmentsMonthlyByBuilding(
              id,
              targetMonth,
            );
            if (aptMonthly.length >= 3) {
              const values = aptMonthly.map((r) => num(r.consumption));
              const mean = values.reduce((s, v) => s + v, 0) / values.length;
              const variance =
                values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
              const stdDev = Math.sqrt(variance);

              lines.push("");
              lines.push(
                `Apartment breakdown (${targetMonth}): avg ${m3(mean)}, σ ${m3(stdDev)} (${aptMonthly.length} apts)`,
              );

              for (const r of aptMonthly) {
                const val = num(r.consumption);
                if (stdDev > 0 && Math.abs(val - mean) > 2 * stdDev) {
                  const severity =
                    Math.abs(val - mean) > 3 * stdDev ? "HIGH" : "MEDIUM";
                  const dir = val > mean ? "above" : "below";
                  anomalies.push({
                    type: "apartment",
                    label: `#${r.apartmentNumber} (${targetMonth})`,
                    value: round(val),
                    mean: round(mean),
                    deviation: round((val - mean) / stdDev, 1),
                    severity,
                  });
                  lines.push(
                    `  ${severity === "HIGH" ? "🔴" : "🟡"} #${r.apartmentNumber}: ${m3(val)} — ${round(Math.abs(val - mean) / stdDev, 1)}σ ${dir} avg`,
                  );
                }
              }
              if (!anomalies.some((a) => a.type === "apartment")) {
                lines.push(
                  "  ✅ All apartments within normal range for this month.",
                );
              }
            }
          } catch {
            lines.push(
              `Could not retrieve apartment breakdown for ${targetMonth}.`,
            );
          }
        }

        return result(joinLines(lines), {
          buildingId: id,
          anomalies,
          monthAnalyzed: targetMonth,
        });
      },
    ),
  );

  server.registerTool(
    "recommend_savings_actions",
    {
      title: "Recommend water savings",
      description:
        "Generates actionable water-saving recommendations based on a building's consumption patterns, top consumers, IoT gateway health, and recent trends. Includes estimated savings potential if the highest consumers reduce to average levels.",
      inputSchema: { ...buildingArgs },
      annotations: READ_ONLY,
    },
    withClient(async (client, a: z.infer<z.ZodObject<typeof buildingArgs>>) => {
      const id = await resolveBuildingId(client, a);
      const [monthlyS, topS, centralsS, changeS] = await Promise.allSettled([
        client.getBuildingMonthly(id, { months: 6 }),
        client.getTopConsumers(id, 10),
        client.getCentralsByBuilding(id),
        client.getBuildingDailyChange(id),
      ]);

      interface Recommendation {
        priority: "HIGH" | "MEDIUM" | "LOW";
        action: string;
        estimatedSavings?: string;
      }

      const recs: Recommendation[] = [];

      // Trend analysis
      const monthly = monthlyS.status === "fulfilled" ? monthlyS.value : [];
      if (monthly.length >= 4) {
        const sorted = [...monthly].sort((a, b) =>
          a.month.localeCompare(b.month),
        );
        const half = Math.floor(sorted.length / 2);
        const firstAvg =
          sorted.slice(0, half).reduce((s, r) => s + num(r.consumption), 0) /
          half;
        const secondAvg =
          sorted.slice(half).reduce((s, r) => s + num(r.consumption), 0) /
          (sorted.length - half);
        if (firstAvg > 0 && secondAvg > firstAvg * 1.15) {
          recs.push({
            priority: "HIGH",
            action:
              "Consumption is trending up (+15% or more). Conduct a building-wide audit and communicate with residents about water conservation.",
            estimatedSavings: `~${m3(round((secondAvg - firstAvg) * 0.5))} per month if trend is reversed`,
          });
        }
      }

      // Top consumers
      const top = topS.status === "fulfilled" ? topS.value : [];
      if (top.length >= 3) {
        const avg =
          top.reduce((s, c) => s + num(c.totalConsumption), 0) / top.length;
        const highConsumers = top.filter(
          (c) => num(c.totalConsumption) > avg * 2,
        );
        if (highConsumers.length > 0) {
          const excessPerDay = highConsumers.reduce(
            (s, c) => s + (num(c.totalConsumption) - avg),
            0,
          );
          recs.push({
            priority: "HIGH",
            action: `${highConsumers.length} apartment(s) consume more than 2× the average. Contact tenants/owners of #${highConsumers.map((c) => c.apartmentNumber).join(", #")} for awareness or leak inspection.`,
            estimatedSavings: `~${m3(round(excessPerDay * 30))} per month if reduced to average`,
          });
        }
      }

      // IoT health
      const centrals = centralsS.status === "fulfilled" ? centralsS.value : [];
      const inactiveCentrals = centrals.filter((c) => !c.isActive);
      if (inactiveCentrals.length > 0) {
        recs.push({
          priority: "MEDIUM",
          action: `${inactiveCentrals.length} IoT gateway(s) are inactive. Schedule maintenance to restore real-time monitoring — unmonitored zones may have undetected leaks.`,
        });
      }

      // Day-over-day spike
      const changePct =
        changeS.status === "fulfilled"
          ? (changeS.value?.changePercentage ?? 0)
          : 0;
      if (changePct > 25) {
        recs.push({
          priority: "HIGH",
          action: `Today's consumption spiked ${pct(changePct)} vs yesterday. Investigate for burst pipe, valve issue, or unusual tenant activity.`,
        });
      }

      // General tips
      if (recs.length === 0) {
        recs.push({
          priority: "LOW",
          action:
            "Building consumption is within normal ranges. Continue routine monitoring and schedule quarterly audits.",
        });
      }

      recs.sort((a, b) => {
        const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
        return order[a.priority] - order[b.priority];
      });

      const lines: string[] = [`💡 Savings Recommendations`, ""];
      const emoji = { HIGH: "🔴", MEDIUM: "🟡", LOW: "🟢" };
      for (const r of recs) {
        lines.push(`${emoji[r.priority]} [${r.priority}] ${r.action}`);
        if (r.estimatedSavings) {
          lines.push(`   Potential savings: ${r.estimatedSavings}`);
        }
      }

      return result(joinLines(lines), {
        buildingId: id,
        recommendations: recs,
      });
    }),
  );

  server.registerTool(
    "generate_building_health_report",
    {
      title: "Building health report",
      description:
        "All-in-one diagnostic report for a building: health score (0-100), consumption summary, billing trend, top consumers, IoT status, leak risk indicators, and recommendations. This is the comprehensive 'check-up' for a building. (Do not call other diagnostic tools like detect_potential_leaks, identify_consumption_anomalies, or find_high_risk_apartments when using this report, as it already includes all necessary risk and anomaly indicators).",
      inputSchema: { ...buildingArgs },
      annotations: READ_ONLY,
    },
    withClient(async (client, a: z.infer<z.ZodObject<typeof buildingArgs>>) => {
      const id = await resolveBuildingId(client, a);
      const [buildingS, dailyS, changeS, monthlyS, topS, centralsS] =
        await Promise.allSettled([
          client.getBuilding(id),
          client.getBuildingDaily(id),
          client.getBuildingDailyChange(id),
          client.getBuildingMonthly(id, { months: 12 }),
          client.getTopConsumers(id, 10),
          client.getCentralsByBuilding(id),
        ]);

      const name = buildingS.status === "fulfilled" ? buildingS.value.name : id;
      const building =
        buildingS.status === "fulfilled" ? buildingS.value : null;

      // Health score calculation
      let healthScore = 100;
      const issues: string[] = [];

      // Day-over-day change
      const changePct =
        changeS.status === "fulfilled"
          ? (changeS.value?.changePercentage ?? 0)
          : 0;
      if (Math.abs(changePct) > 30) {
        healthScore -= 20;
        issues.push(`Large daily swing: ${pct(changePct)}`);
      } else if (Math.abs(changePct) > 15) {
        healthScore -= 10;
        issues.push(`Notable daily change: ${pct(changePct)}`);
      }

      // Monthly trend
      const monthly = monthlyS.status === "fulfilled" ? monthlyS.value : [];
      if (monthly.length >= 4) {
        const sorted = [...monthly].sort((a, b) =>
          a.month.localeCompare(b.month),
        );
        const half = Math.floor(sorted.length / 2);
        const firstAvg =
          sorted.slice(0, half).reduce((s, r) => s + num(r.consumption), 0) /
          half;
        const secondAvg =
          sorted.slice(half).reduce((s, r) => s + num(r.consumption), 0) /
          (sorted.length - half);
        if (firstAvg > 0) {
          const trendPct = ((secondAvg - firstAvg) / firstAvg) * 100;
          if (trendPct > 20) {
            healthScore -= 25;
            issues.push(`Consumption rising: ${pct(trendPct)} trend`);
          } else if (trendPct > 10) {
            healthScore -= 12;
            issues.push(`Consumption gradually increasing: ${pct(trendPct)}`);
          }
        }
      }

      // IoT health
      const centrals = centralsS.status === "fulfilled" ? centralsS.value : [];
      if (centrals.length > 0) {
        const inactiveRatio =
          centrals.filter((c) => !c.isActive).length / centrals.length;
        if (inactiveRatio > 0.5) {
          healthScore -= 20;
          issues.push(
            `${Math.round(inactiveRatio * 100)}% of IoT gateways inactive`,
          );
        } else if (inactiveRatio > 0) {
          healthScore -= Math.round(inactiveRatio * 20);
          issues.push(
            `${centrals.filter((c) => !c.isActive).length} IoT gateway(s) down`,
          );
        }
      }

      // Top consumer concentration
      const top = topS.status === "fulfilled" ? topS.value : [];
      if (top.length >= 3) {
        const topTotal = top
          .slice(0, 3)
          .reduce((s, c) => s + num(c.totalConsumption), 0);
        const allTotal = top.reduce((s, c) => s + num(c.totalConsumption), 0);
        if (allTotal > 0 && topTotal / allTotal > 0.6) {
          healthScore -= 15;
          issues.push(
            `Top 3 apartments account for ${round((topTotal / allTotal) * 100)}% of consumption`,
          );
        }
      }

      healthScore = Math.max(0, Math.min(100, healthScore));

      const scoreEmoji =
        healthScore >= 80 ? "🟢" : healthScore >= 50 ? "🟡" : "🔴";
      const scoreLabel =
        healthScore >= 80
          ? "Healthy"
          : healthScore >= 50
            ? "Needs Attention"
            : "Critical";

      // Report
      const lines: (string | undefined)[] = [
        `🏥 Building Health Report — ${name}`,
        `Health Score: ${scoreEmoji} ${healthScore}/100 (${scoreLabel})`,
      ];

      // Building info
      if (building) {
        lines.push("");
        lines.push(
          `📍 ${building.address}${building.addressNumber ? ` ${building.addressNumber}` : ""}, ${building.municipality}`,
        );
        lines.push(
          `${building.totalApartments} apartments${building.floors ? ` · ${building.floors} floors` : ""}`,
        );
      }

      // Today's consumption
      if (dailyS.status === "fulfilled" && dailyS.value) {
        lines.push("");
        lines.push("── Today ──");
        lines.push(
          `Consumption: ${m3(dailyS.value.consumption)} (change: ${pct(changePct)})`,
        );
      }

      // Monthly trend
      if (monthly.length > 0) {
        const sorted = [...monthly].sort((a, b) =>
          a.month.localeCompare(b.month),
        );
        const totalConsumption = sorted.reduce(
          (s, r) => s + num(r.consumption),
          0,
        );
        const totalPayment = sorted.reduce((s, r) => s + num(r.payment), 0);
        lines.push("");
        lines.push(`── ${sorted.length}-Month History ──`);
        lines.push(`Total: ${m3(totalConsumption)} · ${bs(totalPayment)}`);
        lines.push(`Avg/month: ${m3(totalConsumption / sorted.length)}`);
        const last3 = sorted.slice(-3);
        for (const r of last3) {
          lines.push(`  ${r.month}: ${m3(r.consumption)} → ${bs(r.payment)}`);
        }
      }

      // Top consumers
      if (top.length > 0) {
        lines.push("");
        lines.push("── Top Consumers (yesterday) ──");
        top
          .slice(0, 5)
          .forEach((c, i) =>
            lines.push(
              `  ${i + 1}. #${c.apartmentNumber} (${c.username}) — ${m3(c.totalConsumption)}`,
            ),
          );
      }

      // IoT
      if (centrals.length > 0) {
        const active = centrals.filter((c) => c.isActive).length;
        lines.push("");
        lines.push("── IoT Gateways ──");
        lines.push(`${active}/${centrals.length} active`);
      }

      // Issues & recommendations
      if (issues.length > 0) {
        lines.push("");
        lines.push("── Issues Detected ──");
        issues.forEach((issue) => lines.push(`  ⚠️ ${issue}`));
      }

      return result(joinLines(lines), {
        buildingId: id,
        healthScore,
        status: scoreLabel,
        issues,
        building,
        today: dailyS.status === "fulfilled" ? dailyS.value : null,
        changePercentage: changePct,
        monthly,
        topConsumers: top,
        centrals,
      });
    }),
  );
}

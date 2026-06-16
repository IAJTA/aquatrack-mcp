export function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function round(v: unknown, decimals = 2): number {
  const n = num(v);
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

export const m3 = (v: unknown) => `${round(v)} m³`;
export const litres = (v: unknown) => `${round(v)} L`;
export const bs = (v: unknown) => `Bs ${round(v, 2).toFixed(2)}`;
export const pct = (v: unknown) =>
  `${round(v, 1) >= 0 ? "+" : ""}${round(v, 1)}%`;

export function joinLines(
  lines: (string | false | null | undefined)[],
): string {
  return lines
    .filter((l): l is string => typeof l === "string" && l.length > 0)
    .join("\n");
}

export function result(
  text: string,
  structuredContent?: Record<string, unknown>,
) {
  return {
    content: [{ type: "text" as const, text }],
    ...(structuredContent ? { structuredContent } : {}),
  };
}

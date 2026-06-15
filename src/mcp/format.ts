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

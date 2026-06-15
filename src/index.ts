function main(): void {
  console.log("AquaTrack MCP gateway starting...");
  console.log("AquaTrack MCP gateway successfully initialized.");
}

try {
  main();
} catch (err) {
  process.stderr.write(
    `Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}

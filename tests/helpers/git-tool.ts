// Resolve the active Apple Git once. Its /usr/bin dispatcher launches the
// developer tool resolver for each Git process in a fixture.
export const developerGit = process.platform === "darwin"
  ? Bun.spawnSync(["/usr/bin/xcrun", "--find", "git"]).stdout.toString().trim()
  : "";

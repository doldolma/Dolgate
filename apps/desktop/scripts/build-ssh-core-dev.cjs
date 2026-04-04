const path = require("node:path");
const { spawnSync } = require("node:child_process");

function main() {
  const scriptPath = path.join(__dirname, "build-ssh-core.cjs");
  const target =
    process.platform === "win32"
      ? ["win32", "x64"]
      : process.platform === "darwin"
        ? ["darwin", "universal"]
        : null;

  if (!target) {
    return;
  }

  const result = spawnSync(process.execPath, [scriptPath, ...target], {
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error("Local ssh-core dev binary build failed.");
  }
}

main();

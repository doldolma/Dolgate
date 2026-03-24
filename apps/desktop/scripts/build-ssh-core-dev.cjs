const path = require("node:path");
const { spawnSync } = require("node:child_process");

function main() {
  if (process.platform !== "win32") {
    return;
  }

  const scriptPath = path.join(__dirname, "build-ssh-core.cjs");
  const result = spawnSync(process.execPath, [scriptPath, "win32", "x64"], {
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error("Local ssh-core dev binary build failed.");
  }
}

main();

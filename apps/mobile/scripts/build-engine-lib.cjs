// Builds the Go SSH engine as a step inside another script.
//
// The dev and release scripts used to prebuild the russh native artifacts here;
// they now build the Go engine instead. It has to happen before the platform
// build, because Gradle and CocoaPods both fail outright when the artifact is
// missing — deliberately, since a missing engine means no SSH at all.

const path = require("node:path");
const { spawnSync } = require("node:child_process");

/**
 * @param {"android" | "ios"} platform
 * @param {string} [androidAbis] comma-separated ABI list; defaults to the
 *   release ABI set inside build-engine.cjs.
 */
function buildGoEngine(platform, androidAbis) {
  const script = path.join(__dirname, "build-engine.cjs");
  const args = [script, platform];
  if (platform === "android" && androidAbis) {
    args.push(androidAbis);
  }

  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(
      `Go SSH engine build failed for ${platform}. See the output above; gomobile must be installed (go install golang.org/x/mobile/cmd/gomobile@latest).`,
    );
  }
}

module.exports = { buildGoEngine };

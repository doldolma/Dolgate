const { existsSync } = require("node:fs");
const path = require("node:path");

function resolvePackagedAppTarget({
  platform,
  arch,
  targetPlatform,
  targetArch,
}) {
  const resolvedPlatform = (targetPlatform || platform || "").trim();
  const resolvedArch = (targetArch || arch || "").trim();

  if (!resolvedPlatform) {
    throw new Error("packaged desktop app target platform is not set");
  }
  if (!resolvedArch) {
    throw new Error("packaged desktop app target arch is not set");
  }

  return {
    platform: resolvedPlatform,
    arch: resolvedArch,
    outputDirName: `dolgate-${resolvedPlatform}-${resolvedArch}`,
  };
}

function buildPackagedAppCandidates({ outputDir, platform, electronPath }) {
  if (platform === "darwin") {
    return [
      {
        candidatePath: path.join(
          outputDir,
          "dolgate.app",
          "Contents",
          "MacOS",
          "dolgate",
        ),
        launch: {
          executablePath: path.join(
            outputDir,
            "dolgate.app",
            "Contents",
            "MacOS",
            "dolgate",
          ),
          args: [],
        },
      },
      {
        candidatePath: path.join(
          outputDir,
          "dolgate.app",
          "Contents",
          "Resources",
          "app.asar",
        ),
        launch: {
          executablePath: electronPath,
          args: [
            path.join(
              outputDir,
              "dolgate.app",
              "Contents",
              "Resources",
              "app.asar",
            ),
          ],
        },
      },
    ];
  }

  if (platform === "win32") {
    return [
      {
        candidatePath: path.join(outputDir, "dolgate.exe"),
        launch: {
          executablePath: path.join(outputDir, "dolgate.exe"),
          args: [],
        },
      },
      {
        candidatePath: path.join(outputDir, "resources", "app.asar"),
        launch: {
          executablePath: electronPath,
          args: [path.join(outputDir, "resources", "app.asar")],
        },
      },
    ];
  }

  return [
    {
      candidatePath: path.join(outputDir, "dolgate"),
      launch: {
        executablePath: path.join(outputDir, "dolgate"),
        args: [],
      },
    },
    {
      candidatePath: path.join(outputDir, "resources", "app.asar"),
      launch: {
        executablePath: electronPath,
        args: [path.join(outputDir, "resources", "app.asar")],
      },
    },
  ];
}

function resolvePackagedAppLaunch({
  override,
  electronPath,
  outDir,
  platform,
  arch,
  targetPlatform,
  targetArch,
  pathExists = existsSync,
}) {
  const normalizedOverride = override?.trim();
  if (normalizedOverride) {
    const resolvedOverride = path.resolve(normalizedOverride);
    if (resolvedOverride.toLowerCase().endsWith(".asar")) {
      return {
        executablePath: electronPath,
        args: [resolvedOverride],
      };
    }
    return {
      executablePath: resolvedOverride,
      args: [],
    };
  }

  const resolvedOutDir = path.resolve(outDir);
  const target = resolvePackagedAppTarget({
    platform,
    arch,
    targetPlatform,
    targetArch,
  });
  const expectedOutputDir = path.join(resolvedOutDir, target.outputDirName);

  for (const candidate of buildPackagedAppCandidates({
    outputDir: expectedOutputDir,
    platform: target.platform,
    electronPath,
  })) {
    if (pathExists(candidate.candidatePath)) {
      return candidate.launch;
    }
  }

  throw new Error(
    `failed to locate packaged desktop app target ${target.outputDirName} under ${resolvedOutDir}`,
  );
}

module.exports = {
  resolvePackagedAppLaunch,
};

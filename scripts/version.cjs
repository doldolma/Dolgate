const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const rootPackagePath = path.join(repoRoot, "package.json");
const desktopPackagePath = path.join(repoRoot, "apps", "desktop", "package.json");
const mobilePackagePath = path.join(repoRoot, "apps", "mobile", "package.json");
const lockfilePath = path.join(repoRoot, "package-lock.json");
const androidGradlePath = path.join(
  repoRoot,
  "apps",
  "mobile",
  "android",
  "app",
  "build.gradle",
);
const iosProjectPath = path.join(
  repoRoot,
  "apps",
  "mobile",
  "ios",
  "Dolgate.xcodeproj",
  "project.pbxproj",
);
const desktopReleaseWorkflowPath = path.join(
  repoRoot,
  ".github",
  "workflows",
  "desktop-release.yml",
);
const syncApiWorkflowPath = path.join(
  repoRoot,
  ".github",
  "workflows",
  "sync-api-container.yml",
);

const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function assertSemver(version) {
  if (!semverPattern.test(version)) {
    throw new Error(`Invalid semver: ${version}`);
  }
}

function readRootVersion() {
  return readJson(rootPackagePath).version;
}

function bumpVersion(version, kind) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/u);
  if (!match) {
    throw new Error(`Cannot bump invalid semver: ${version}`);
  }

  let major = Number.parseInt(match[1], 10);
  let minor = Number.parseInt(match[2], 10);
  let patch = Number.parseInt(match[3], 10);

  switch (kind) {
    case "patch":
      patch += 1;
      break;
    case "minor":
      minor += 1;
      patch = 0;
      break;
    case "major":
      major += 1;
      minor = 0;
      patch = 0;
      break;
    default:
      throw new Error(`Unsupported bump kind: ${kind}`);
  }

  return `${major}.${minor}.${patch}`;
}

function updateIosMarketingVersion(contents, version) {
  return contents.replace(/MARKETING_VERSION = [^;]+;/gu, `MARKETING_VERSION = ${version};`);
}

function setVersion(version) {
  assertSemver(version);

  const rootPackage = readJson(rootPackagePath);
  const desktopPackage = readJson(desktopPackagePath);
  const mobilePackage = readJson(mobilePackagePath);
  const lockfile = readJson(lockfilePath);

  rootPackage.version = version;
  desktopPackage.version = version;
  mobilePackage.version = version;

  lockfile.version = version;
  if (lockfile.packages?.[""]) {
    lockfile.packages[""].version = version;
  }
  if (lockfile.packages?.["apps/desktop"]) {
    lockfile.packages["apps/desktop"].version = version;
  }
  if (lockfile.packages?.["apps/mobile"]) {
    lockfile.packages["apps/mobile"].version = version;
  }

  writeJson(rootPackagePath, rootPackage);
  writeJson(desktopPackagePath, desktopPackage);
  writeJson(mobilePackagePath, mobilePackage);
  writeJson(lockfilePath, lockfile);

  const iosProject = fs.readFileSync(iosProjectPath, "utf8");
  fs.writeFileSync(iosProjectPath, updateIosMarketingVersion(iosProject, version), "utf8");
}

function checkVersion() {
  const errors = [];

  const rootPackage = readJson(rootPackagePath);
  const desktopPackage = readJson(desktopPackagePath);
  const mobilePackage = readJson(mobilePackagePath);
  const lockfile = readJson(lockfilePath);
  const androidGradle = fs.readFileSync(androidGradlePath, "utf8");
  const iosProject = fs.readFileSync(iosProjectPath, "utf8");
  const desktopReleaseWorkflow = fs.readFileSync(desktopReleaseWorkflowPath, "utf8");
  const syncApiWorkflow = fs.readFileSync(syncApiWorkflowPath, "utf8");

  const expectedVersion = rootPackage.version;

  if (desktopPackage.version !== expectedVersion) {
    errors.push(
      `Desktop package version mismatch: expected ${expectedVersion}, got ${desktopPackage.version}`,
    );
  }

  if (mobilePackage.version !== expectedVersion) {
    errors.push(
      `Mobile package version mismatch: expected ${expectedVersion}, got ${mobilePackage.version}`,
    );
  }

  if (lockfile.version !== expectedVersion) {
    errors.push(
      `package-lock version mismatch: expected ${expectedVersion}, got ${lockfile.version}`,
    );
  }

  if (lockfile.packages?.[""]?.version !== expectedVersion) {
    errors.push(
      `package-lock root package mismatch: expected ${expectedVersion}, got ${lockfile.packages?.[""]?.version}`,
    );
  }

  if (lockfile.packages?.["apps/desktop"]?.version !== expectedVersion) {
    errors.push(
      `package-lock desktop package mismatch: expected ${expectedVersion}, got ${lockfile.packages?.["apps/desktop"]?.version}`,
    );
  }

  if (lockfile.packages?.["apps/mobile"]?.version !== expectedVersion) {
    errors.push(
      `package-lock mobile package mismatch: expected ${expectedVersion}, got ${lockfile.packages?.["apps/mobile"]?.version}`,
    );
  }

  if (!androidGradle.includes('file("../../../../package.json").text')) {
    errors.push("Android build.gradle is not reading the root package version.");
  }

  if (!androidGradle.includes("versionName rootVersionName")) {
    errors.push("Android build.gradle is not wiring versionName to the root package version.");
  }

  const marketingVersions = Array.from(
    iosProject.matchAll(/MARKETING_VERSION = ([^;]+);/gu),
    (match) => match[1],
  );
  if (marketingVersions.length === 0) {
    errors.push("iOS project does not declare MARKETING_VERSION.");
  } else if (marketingVersions.some((value) => value !== expectedVersion)) {
    errors.push(
      `iOS MARKETING_VERSION mismatch: expected ${expectedVersion}, got ${marketingVersions.join(", ")}`,
    );
  }

  if (!desktopReleaseWorkflow.includes("npm run version:check")) {
    errors.push("Desktop release workflow is not invoking the root version check.");
  }

  if (!desktopReleaseWorkflow.includes("const rootVersion = require('./package.json').version;")) {
    errors.push("Desktop release workflow is not validating the root package version.");
  }

  if (!desktopReleaseWorkflow.includes("Dolgate-android-v${version}.apk")) {
    errors.push("Desktop release workflow is not packaging the Android APK into the unified release.");
  }

  if (!syncApiWorkflow.includes("const rootVersion = require('./package.json').version;")) {
    errors.push("sync-api workflow is not validating the root package version.");
  }

  if (!syncApiWorkflow.includes("VERSION=${{ needs.verify-version.outputs.version }}")) {
    errors.push("sync-api workflow is not injecting the verified root version into the build.");
  }

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    process.exit(1);
  }

  console.log(`Version check passed for ${expectedVersion}`);
  console.log("Remember to increment Android versionCode and iOS CURRENT_PROJECT_VERSION separately.");
}

function main() {
  const command = process.argv[2];

  switch (command) {
    case "set": {
      const version = process.argv[3];
      if (!version) {
        throw new Error("Usage: node ./scripts/version.cjs set <semver>");
      }
      setVersion(version);
      console.log(`Version updated to ${version}`);
      return;
    }
    case "check":
      checkVersion();
      return;
    case "bump": {
      const bumpKind = process.argv[3];
      if (!["patch", "minor", "major"].includes(bumpKind)) {
        throw new Error("Usage: node ./scripts/version.cjs bump <patch|minor|major>");
      }
      const nextVersion = bumpVersion(readRootVersion(), bumpKind);
      setVersion(nextVersion);
      console.log(`Version bumped to ${nextVersion}`);
      return;
    }
    default:
      throw new Error("Usage: node ./scripts/version.cjs <set|check|bump> ...");
  }
}

main();

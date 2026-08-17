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
// 리눅스 상점(App Center·GNOME 소프트웨어)이 읽는 메타데이터. 버전과 릴리스 날짜가 여기에도
// 있어서, 손으로 고치기로 두면 잊는다 — 잊어도 설치는 되고 상점만 옛 버전으로 보인다.
const desktopMetainfoPath = path.join(
  repoRoot,
  "apps",
  "desktop",
  "build",
  "linux",
  "com.doldolma.dolgate.metainfo.xml",
);

const releaseWorkflowPath = path.join(
  repoRoot,
  ".github",
  "workflows",
  "release.yml",
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

/** 오늘 날짜(YYYY-MM-DD). 실행하는 사람의 달력 기준이다 — UTC 로 자르면 아침에 어제가 된다. */
function today() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * metainfo 의 릴리스 목록에 이 버전을 채운다.
 *
 * 이미 있으면 날짜만 오늘로 바꾸고(같은 버전을 다시 찍는 경우), 없으면 **맨 앞에** 넣는다 —
 * AppStream 은 최신이 위인 목록을 기대한다. 지난 릴리스는 지우지 않는다(상점이 변경 이력으로 쓴다).
 */
function updateMetainfoReleases(contents, version, date) {
  const entry = `<release version="${version}" date="${date}" />`;

  // 버전 문자열을 정규식에 넣지 않는다 — 점을 이스케이프하는 것을 잊기 쉽고, 그러면 1.9.1 이
  // 1x9x1 에도 걸린다. 여는 태그를 문자열로 찾고 그 항목의 끝(`/>`)까지만 갈아 끼운다.
  const openAt = contents.indexOf(`<release version="${version}"`);
  if (openAt >= 0) {
    const closeAt = contents.indexOf("/>", openAt);
    if (closeAt < 0) {
      throw new Error(`metainfo 의 ${version} release 항목이 닫히지 않았습니다.`);
    }
    return contents.slice(0, openAt) + entry + contents.slice(closeAt + 2);
  }

  const openTag = contents.match(/([ \t]*)<releases>\n/u);
  if (!openTag) {
    throw new Error("metainfo 에 <releases> 블록이 없습니다.");
  }
  // 최신이 위인 목록이다(AppStream 규격). 지난 릴리스는 지우지 않는다 — 상점이 변경 이력으로 쓴다.
  const indent = `${openTag[1]}  `;
  return contents.replace(openTag[0], `${openTag[0]}${indent}${entry}\n`);
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

  const metainfo = fs.readFileSync(desktopMetainfoPath, "utf8");
  fs.writeFileSync(
    desktopMetainfoPath,
    updateMetainfoReleases(metainfo, version, process.env.DOLGATE_RELEASE_DATE || today()),
    "utf8",
  );
}

function checkVersion() {
  const errors = [];

  const rootPackage = readJson(rootPackagePath);
  const desktopPackage = readJson(desktopPackagePath);
  const mobilePackage = readJson(mobilePackagePath);
  const lockfile = readJson(lockfilePath);
  const androidGradle = fs.readFileSync(androidGradlePath, "utf8");
  const iosProject = fs.readFileSync(iosProjectPath, "utf8");
  const releaseWorkflow = fs.readFileSync(releaseWorkflowPath, "utf8");
  const desktopMetainfo = fs.readFileSync(desktopMetainfoPath, "utf8");
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

  // 상점의 버전·갱신일이 이 목록에서 온다. version:set/bump 가 채우므로, 없다는 것은 누군가
  // package.json 만 손으로 고쳤다는 뜻이다.
  const metainfoReleases = Array.from(
    desktopMetainfo.matchAll(/<release\s+version="([^"]+)"/gu),
    (match) => match[1],
  );
  if (!metainfoReleases.includes(expectedVersion)) {
    errors.push(
      `Desktop metainfo has no release for ${expectedVersion}: ${metainfoReleases.join(", ") || "(none)"}. ` +
        "Run npm run version:set to fill it in.",
    );
  }

  if (!releaseWorkflow.includes("npm run version:check")) {
    errors.push("Release workflow is not invoking the root version check.");
  }

  if (!releaseWorkflow.includes("const rootVersion = require('./package.json').version;")) {
    errors.push("Release workflow is not validating the root package version.");
  }

  if (!releaseWorkflow.includes("Dolgate-android-v${version}.apk")) {
    errors.push("Release workflow is not packaging the Android APK into the unified release.");
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

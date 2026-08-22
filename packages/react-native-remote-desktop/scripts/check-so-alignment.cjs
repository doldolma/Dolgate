#!/usr/bin/env node
"use strict";

/**
 * 네이티브 라이브러리가 16KB 페이지 경계에 맞는지 검사한다.
 *
 * 최근 ARM64 안드로이드 기기는 16KB 페이지로 동작할 수 있고, 그런 기기에서는 LOAD 세그먼트가
 * 4KB 로 맞은 .so 를 커널이 매핑하지 못해 `dlopen` 이 실패한다 — 앱이 RDP/VNC 세션을 여는
 * 순간 죽는다. NDK 기본값이 4KB 라서 링커 플래그(`-Wl,-z,max-page-size=16384`)를 빼먹으면
 * 조용히 되돌아간다. 그 실수를 사람이 기억하지 않게 여기서 막는다.
 *
 * 검사 대상은 이 모듈이 만들어 AAR 로 내보내는 .so 전부다(Rust 코어 + JNI 브릿지).
 */

const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REQUIRED_ALIGN = 0x4000;
const moduleRoot = path.resolve(__dirname, "..");
const androidBuild = path.join(moduleRoot, "android", "build");

/** LOAD 정렬을 읽을 도구. CI(ubuntu)에는 binutils 의 readelf 가 있고, 없으면 NDK 것을 쓴다. */
function resolveReadelf() {
  const candidates = ["readelf", "llvm-readelf"];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (probe.status === 0) {
      return candidate;
    }
  }

  const ndkRoots = [
    process.env.ANDROID_NDK_HOME,
    process.env.ANDROID_NDK_ROOT,
  ].filter(Boolean);
  const sdkRoot = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (sdkRoot && fs.existsSync(path.join(sdkRoot, "ndk"))) {
    for (const entry of fs.readdirSync(path.join(sdkRoot, "ndk"))) {
      ndkRoots.push(path.join(sdkRoot, "ndk", entry));
    }
  }

  for (const ndkRoot of ndkRoots) {
    const prebuilt = path.join(ndkRoot, "toolchains", "llvm", "prebuilt");
    if (!fs.existsSync(prebuilt)) {
      continue;
    }
    for (const host of fs.readdirSync(prebuilt)) {
      const tool = path.join(prebuilt, host, "bin", "llvm-readelf");
      if (fs.existsSync(tool)) {
        return tool;
      }
    }
  }

  return null;
}

function findFiles(root, matches) {
  if (!fs.existsSync(root)) {
    return [];
  }
  const found = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...findFiles(full, matches));
    } else if (matches(full)) {
      found.push(full);
    }
  }
  return found;
}

/** AAR 안의 .so 를 임시 디렉터리로 풀어 놓고 경로를 돌려준다. */
function extractAarLibraries(aarPath, outDir) {
  const listed = execFileSync("unzip", ["-Z1", aarPath], { encoding: "utf8" })
    .split("\n")
    .filter(name => /^jni\/[^/]+\/.+\.so$/.test(name.trim()));
  if (listed.length === 0) {
    return [];
  }
  execFileSync("unzip", ["-o", "-q", aarPath, "jni/*", "-d", outDir]);
  return listed.map(name => path.join(outDir, name.trim()));
}

function loadAlignments(readelf, file) {
  const output = execFileSync(readelf, ["-lW", file], { encoding: "utf8" });
  const aligns = new Set();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("LOAD")) {
      continue;
    }
    const last = trimmed.split(/\s+/).at(-1);
    if (last) {
      aligns.add(last);
    }
  }
  return [...aligns];
}

function main() {
  const readelf = resolveReadelf();
  if (!readelf) {
    console.error(
      "readelf/llvm-readelf 를 찾지 못했습니다. binutils 를 설치하거나 ANDROID_NDK_HOME 을 지정하세요.",
    );
    process.exit(1);
  }

  // **모듈이 실제로 내보내는 AAR 만 본다.** build/ 아래에는 중간 산출물과 예전 ABI 의 복사본이
  // 남아 있어서(gradle 이 지우지 않는다) 전부 훑으면 이미 지나간 빌드가 실패로 잡힌다.
  const aars = findFiles(path.join(androidBuild, "outputs", "aar"), file =>
    file.endsWith(".aar"),
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "so-align-"));
  const targets = [];
  for (const aar of aars) {
    targets.push(...extractAarLibraries(aar, tempDir));
  }

  if (targets.length === 0) {
    console.error(
      `검사할 .so 가 없습니다(${path.join(androidBuild, "outputs", "aar")}). ` +
        "먼저 안드로이드 모듈을 빌드하세요.",
    );
    process.exit(1);
  }

  const failures = [];
  for (const target of targets) {
    const aligns = loadAlignments(readelf, target);
    const ok =
      aligns.length > 0 &&
      aligns.every(align => Number.parseInt(align, 16) >= REQUIRED_ALIGN);
    const label = `${path.basename(path.dirname(target))}/${path.basename(target)}`;
    if (ok) {
      console.log(`OK  ${label} LOAD align=${aligns.join(",")}`);
    } else {
      failures.push(`${label} LOAD align=${aligns.join(",") || "(없음)"}`);
    }
  }

  fs.rmSync(tempDir, { recursive: true, force: true });

  if (failures.length > 0) {
    console.error(
      "\n16KB 페이지 정렬이 아닌 라이브러리가 있습니다. 링커에 -Wl,-z,max-page-size=16384 를 주세요:",
    );
    for (const failure of failures) {
      console.error(`  ${failure}`);
    }
    process.exit(1);
  }
}

main();

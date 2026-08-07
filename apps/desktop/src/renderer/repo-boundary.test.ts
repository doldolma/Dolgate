// 저장소 경계 가드 — 주석으로만 지켜지던 불변식을 실패하는 테스트로 승격한다.
//
// 여기 있는 규칙은 전부 "한 번 깨지면 원인을 찾기 어렵고, 깨진 걸 늦게 안다"는 공통점이 있다.
// 새 도구(eslint 등)를 들이지 않고 store/shared-boundary.test.ts 의 파일 스캔 관례를 반복한다.

import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const rendererDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const desktopDir = path.resolve(rendererDir, "..", "..");
const repoRoot = path.resolve(desktopDir, "..", "..");
const sharedCoreSrcDir = path.join(repoRoot, "packages", "shared-core", "src");

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);

/** 디렉터리를 재귀로 훑어 소스 파일 경로를 모은다. */
function collectSourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "generated") {
          continue;
        }
        walk(fullPath);
        continue;
      }
      if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        found.push(fullPath);
      }
    }
  };
  walk(root);
  return found;
}

/** import/export 구문의 모듈 지정자만 뽑는다(주석 안의 경로 언급에 걸리지 않게). */
function collectModuleSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

describe("저장소 경계", () => {
  it("렌더러는 main 프로세스 모듈을 직접 import 하지 않는다", () => {
    // 렌더러는 preload 가 노출한 IPC 표면으로만 main 과 대화한다. 직접 import 는 번들에
    // Node 전용 코드를 끌어들여 브라우저에서 터지거나, 최악의 경우 조용히 동작하다가
    // 패키징에서만 깨진다. 현재 위반 0건이라 지금 고정하는 것이 가장 싸다.
    //
    // 테스트 파일은 제외한다. 테스트는 브라우저 번들에 들어가지 않으므로 main 모듈을
    // 검증 대상으로 직접 import 하는 것이 정당하다(store/sync-service.test.ts 가 그렇다).
    const offenders: string[] = [];
    for (const file of collectSourceFiles(rendererDir).filter(
      candidate => !/\.test\.tsx?$/.test(candidate),
    )) {
      for (const specifier of collectModuleSpecifiers(
        fs.readFileSync(file, "utf8"),
      )) {
        const looksLikeMain =
          specifier.includes("/main/") ||
          specifier.endsWith("/main") ||
          /(^|\/)\.\.\/main\//.test(specifier);
        if (looksLikeMain) {
          offenders.push(`${path.relative(desktopDir, file)} → ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("shared-core 는 앱(apps/**)을 import 하지 않는다", () => {
    // shared-core 는 데스크톱·모바일이 함께 쓰는 최하층이다. 앱을 거꾸로 참조하면 순환이
    // 생기고, 모바일이 데스크톱 코드를 끌어오는 순간 RN 번들러에서 깨진다.
    const offenders: string[] = [];
    for (const file of collectSourceFiles(sharedCoreSrcDir)) {
      for (const specifier of collectModuleSpecifiers(
        fs.readFileSync(file, "utf8"),
      )) {
        if (specifier.includes("apps/") || specifier.includes("@dolssh/desktop")) {
          offenders.push(
            `${path.relative(repoRoot, file)} → ${specifier}`,
          );
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("렌더러 vite 설정이 react·react-dom·lucide-react 를 루트 단일본에 고정한다", () => {
    // 패키징(sync:runtime-deps)이 node_modules 에 중첩 복사본을 심은 적이 있고, 그때
    // 외부화된 중첩 lucide 가 중첩 react 를 끌어와 렌더러 테스트가 대량으로 깨졌다
    // (아이콘 렌더 시 useContext null). 처방은 이 설정의 alias/dedupe 이고, 지금은 그것이
    // 주석으로만 지켜진다. 설정이 사라지면 같은 사고가 재발하므로 여기서 실패시킨다.
    const config = fs.readFileSync(
      path.join(desktopDir, "vite.renderer.config.ts"),
      "utf8",
    );

    for (const alias of ["react:", "'react-dom':", "'lucide-react':"]) {
      expect(config).toContain(alias);
    }
    // zustand 는 디렉터리 alias 를 걸면 dev 서버가 exports 맵을 우회해 CJS 진입점을 집고
    // named export 가 깨진다 — alias 가 아니라 dedupe 여야 한다.
    expect(config).toContain("dedupe: ['lucide-react', 'zustand']");
  });
});

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mainDir = path.dirname(fileURLToPath(import.meta.url));

// 저장소(HostRepository)는 개인 볼트만 본다. 호스트를 읽는 곳이 저장소를 바로 부르면 팀 볼트가
// 생겼을 때 그 호스트를 못 찾는다 — 그래서 읽기는 VaultCatalog 한 곳으로 모았고, 여기서 지킨다.
const REPOSITORY_READ_ALLOWED = new Set([
  "vault-catalog.ts", // 입구 자신
  "database.ts", // 저장소 자신
  "sync-service.ts", // 개인 동기화 — 개인 볼트만 올려야 한다
]);

// 상태 파일을 바로 읽는 것도 저장소를 건너뛰는 길이다.
const STATE_READ_ALLOWED = new Set([
  "database.ts",
  "state-storage.ts",
  "sync-service.ts",
  // 호스트 가져오기·내보내기: 개인 볼트를 통째로 다루는 일괄 작업이다. 팀에서 쓰게 되면 볼트
  // 데이터 하나를 받게 바꾼다.
  "host-transfer-service.ts",
]);

function collectMainSources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") {
        found.push(...collectMainSources(fullPath));
      }
      continue;
    }
    if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      found.push(fullPath);
    }
  }
  return found;
}

/** 주석 줄과 줄 끝 주석을 비운다(줄 번호는 그대로) — 주석 속 코드 언급에 걸리지 않게. */
function stripComments(content: string): string {
  return content
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
        return "";
      }
      const trailing = line.search(/\s\/\/\s/);
      return trailing >= 0 ? line.slice(0, trailing) : line;
    })
    .join("\n");
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

/**
 * 저장소를 바로 읽는 호출. 받는 쪽이 개인 볼트로 명시된 것(`vaults.personal.hosts.list()`)은
 * 개인 볼트만 봐야 하는 곳이라 허용한다. 여러 줄에 걸친 체인도 잡는다.
 */
function findRepositoryReads(content: string): Array<{ line: number; text: string }> {
  const code = stripComments(content);
  const pattern = /((?:[\w$]+\s*\.\s*)*)(?<![\w$])hosts\s*\.\s*(?:getById|list)\s*\(/g;
  const found: Array<{ line: number; text: string }> = [];
  for (const match of code.matchAll(pattern)) {
    const receiver = match[1].replace(/\s+/g, "");
    if (receiver.endsWith("personal.")) {
      continue;
    }
    found.push({ line: lineOf(code, match.index ?? 0), text: match[0].replace(/\s+/g, "") });
  }
  return found;
}

function findStateReads(content: string): Array<{ line: number; text: string }> {
  const code = stripComments(content);
  const pattern = /(?<![\w$])data\s*\.\s*hosts(?![\w$])/g;
  return [...code.matchAll(pattern)].map((match) => ({
    line: lineOf(code, match.index ?? 0),
    text: match[0].replace(/\s+/g, ""),
  }));
}

describe("vault catalog boundary", () => {
  it("recognizes direct repository and state reads, but not explicit personal reads", () => {
    const sample = [
      "const host = ctx.hosts.getById(id);",
      "const all = this.hosts",
      "  .list();",
      "const mine = vaults.personal.hosts",
      "  .list();",
      "const trusted = knownHosts.list();",
      "// ctx.hosts.getById(id) 는 주석이라 세지 않는다",
      "const raw = state.data.hosts;",
    ].join("\n");

    expect(findRepositoryReads(sample)).toEqual([
      { line: 1, text: "ctx.hosts.getById(" },
      { line: 2, text: "this.hosts.list(" },
    ]);
    expect(findStateReads(sample)).toEqual([{ line: 8, text: "data.hosts" }]);
  });

  it("reads hosts only through the vault catalog", () => {
    const offenders: string[] = [];
    for (const file of collectMainSources(mainDir)) {
      const relativePath = path.relative(mainDir, file);
      const content = fs.readFileSync(file, "utf8");
      if (!REPOSITORY_READ_ALLOWED.has(relativePath)) {
        for (const read of findRepositoryReads(content)) {
          offenders.push(`${relativePath}:${read.line} ${read.text}`);
        }
      }
      if (!STATE_READ_ALLOWED.has(relativePath)) {
        for (const read of findStateReads(content)) {
          offenders.push(`${relativePath}:${read.line} ${read.text}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

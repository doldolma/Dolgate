import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mainDir = path.dirname(fileURLToPath(import.meta.url));

// 접속에 쓸 자격 증명(사용자 이름·인증 방식·비밀값)은 비밀값 코디네이터 한 곳에서 정한다 — 팀 호스트는 내
// 자격 증명이 먼저다. 접속 경로가 호스트의 것을 따로 읽으면 그 경로만 팀 것으로 붙어 내 것을 건너뛴다.
const RESOLVER = path.join("ipc", "coordinators", "secret-coordinator.ts");
// 가져오기는 다른 앱의 설정으로 호스트 초안을 만드는 곳이라 인증 방식을 읽는다(접속하지 않는다).
const AUTH_TYPE_READ_ALLOWED = new Set([
  RESOLVER,
  "openssh-import-service.ts",
  "xshell-import-service.ts",
  path.join("ipc", "imports.ts"),
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
    if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.includes("test-support")) {
      found.push(fullPath);
    }
  }
  return found;
}

/** 주석 줄과 줄 끝 주석을 비운다(줄 번호는 그대로). */
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

function findAll(content: string, pattern: RegExp): Array<{ line: number; text: string }> {
  const code = stripComments(content);
  return [...code.matchAll(pattern)].map((match) => ({
    line: code.slice(0, match.index ?? 0).split("\n").length,
    text: match[0].replace(/\s+/g, ""),
  }));
}

// 옛 두 함수는 코디네이터 안에서만 남는다(resolveSshAuth 가 쓴다).
const findOldResolvers = (content: string) =>
  findAll(content, /(?<![\w$])(?:requireConfiguredSshUsername|resolveRuntimeSshSecrets)\s*\(/g);
const findAuthTypeReads = (content: string) => findAll(content, /(?<![\w$])\w*[Hh]ost\s*\.\s*authType(?![\w$])/g);
const findHostSecretReads = (content: string) =>
  findAll(content, /(?<![\w$])loadSecrets\s*\(\s*\w*[Hh]ost\s*\.\s*secretRef/g);

describe("ssh auth boundary", () => {
  it("recognizes direct reads of a host's login, but not the resolved one", () => {
    const sample = [
      "const username = ctx.requireConfiguredSshUsername(sshHost);",
      "const { secrets } = await ctx.resolveRuntimeSshSecrets(sshHost, input.secrets);",
      "authType: sshHost.authType,",
      "if (jumpHost.authType === 'agent') {}",
      "const secrets = await ctx.loadSecrets(host.secretRef);",
      "// sshHost.authType 는 주석이라 세지 않는다",
      "const auth = await ctx.resolveSshAuth(sshHost, input.secrets);",
      "authType: auth.authType,",
      "const secrets = await ctx.loadHostSecrets(host);",
    ].join("\n");

    expect(findOldResolvers(sample).map((found) => found.line)).toEqual([1, 2]);
    expect(findAuthTypeReads(sample).map((found) => found.line)).toEqual([3, 4]);
    expect(findHostSecretReads(sample).map((found) => found.line)).toEqual([5]);
  });

  it("decides the login to connect with only in the secret coordinator", () => {
    const offenders: string[] = [];
    for (const file of collectMainSources(mainDir)) {
      const relativePath = path.relative(mainDir, file);
      const content = fs.readFileSync(file, "utf8");
      if (relativePath !== RESOLVER) {
        for (const found of [...findOldResolvers(content), ...findHostSecretReads(content)]) {
          offenders.push(`${relativePath}:${found.line} ${found.text}`);
        }
      }
      if (!AUTH_TYPE_READ_ALLOWED.has(relativePath)) {
        for (const found of findAuthTypeReads(content)) {
          offenders.push(`${relativePath}:${found.line} ${found.text}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

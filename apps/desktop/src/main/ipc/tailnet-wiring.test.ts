import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * tailnet 배선이 빠진 경로는 조용히 일반 네트워크로 나간다 — 실패가 아니라 "왜 tailnet 을
 * 지정했는데 안 되지"로 보인다. ssh-core 쪽은 pkg/runtime/tailnet_wiring_test.go 가 소스로
 * 같은 것을 확인하는데, main 프로세스에는 그 가드가 없어서 컨테이너 셸이 4주 넘게 빠진 채로
 * 있었다(목록·로그는 타고 셸만 안 타서 더 안 보였다).
 *
 * 여기서 소스로 확인하는 이유도 같다 — 경로마다 실제 SSH 서버가 필요해 통합 테스트로는 못 잡고,
 * `tailnetId` 가 optional 이라 타입 검사도 안 잡는다.
 */
const CONSUMERS = [
  "ssh.ts",
  "sftp.ts",
  "containers.ts",
  "port-forwards-dns.ts",
  "vnc.ts",
  "coordinators/container-runtime-coordinator.ts",
  "coordinators/ssh-key-coordinator.ts",
];

// host-coordinator.ts 는 이 목록에 없다. 그것이 만드는 것은 최상위 연결 페이로드가 아니라
// 점프 **홉 서술자**(resolveJumpHostTarget 이 체인을 쌓으며 만드는 `jump: resolved`)이고,
// 홉은 자기 몫의 tailnet 경로를 갖지 않는다 — 소켓을 여는 것은 첫 홉뿐이다.

/**
 * SSH 연결 페이로드를 조립하는 자리를 찾는다.
 *
 * **표식은 `jump` 다.** 둘은 같은 판단에서 나온다 — 실제로 소켓을 여는 것은 첫 홉뿐이므로
 * 점프 체인을 넘기는 페이로드는 tailnet 경로도 함께 넘겨야 한다(resolveTailnetRoute 의
 * "첫 홉 우선" 규칙, 그리고 sshconn.go 의 DialClient 가 재귀 최하단에서만 config.Dial 을
 * 쓰는 것이 그 짝이다). AWS SSM·warpgate 분기는 점프도 tailnet 도 쓰지 않아 여기 안 걸린다.
 *
 * 값의 출처까지 보는 이유: 점프 **홉 서술자**(host-coordinator 의 resolveJumpHostTarget 이
 * 체인을 쌓으며 만드는 `jump: resolved`)도 같은 필드를 갖는데, 그것은 최상위 페이로드가
 * 아니라서 자기 몫의 tailnet 경로를 갖지 않는다.
 */
const PAYLOAD_JUMP = /^[ \t]*jump(,|: *await +resolveJumpHostTarget\()/gm;

function enclosingObjectLiteral(source: string, at: number): string | null {
  let depth = 0;
  let start = -1;
  for (let i = at; i >= 0; i -= 1) {
    const char = source[i];
    if (char === "}") {
      depth += 1;
    } else if (char === "{") {
      if (depth === 0) {
        start = i;
        break;
      }
      depth -= 1;
    }
  }
  if (start < 0) {
    return null;
  }
  depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  return null;
}

function sshConnectPayloads(
  source: string,
): { line: number; hasTailnetRoute: boolean }[] {
  const found: { line: number; hasTailnetRoute: boolean }[] = [];
  PAYLOAD_JUMP.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PAYLOAD_JUMP.exec(source)) !== null) {
    const body = enclosingObjectLiteral(source, match.index);
    // 신뢰 키를 함께 싣는 것만이 SSH 연결 페이로드다(점프 옵션만 받는 probe 류를 걸러낸다).
    if (!body || !body.includes("trustedHostKeysBase64")) {
      continue;
    }
    found.push({
      line: source.slice(0, match.index).split("\n").length,
      hasTailnetRoute: /resolveTailnetRoute\(/.test(body),
    });
  }
  return found;
}

describe("tailnet wiring", () => {
  it.each(CONSUMERS)(
    "%s sends the tailnet route with every SSH connect payload",
    (relativePath) => {
      const source = readFileSync(resolve(here, relativePath), "utf8");
      const missing = sshConnectPayloads(source)
        .filter((payload) => !payload.hasTailnetRoute)
        .map((payload) => `${relativePath}:${payload.line}`);

      expect(
        missing,
        "이 페이로드는 점프 체인은 넘기면서 tailnet 경로는 빼먹었다 — tailnet 호스트의 " +
          "연결이 일반 네트워크로 나가고, 거기서 TOFU 로 받은 호스트 키가 그 tailnet " +
          "범위에 저장된다. `...resolveTailnetRoute(host)` 를 함께 넘겨라.",
      ).toEqual([]);
    },
  );

  // 표식이 사라지면(필드 이름이 바뀌거나 페이로드가 다른 파일로 옮겨가면) 위 검사가 아무것도
  // 안 보고 통과한다. 그 침묵을 여기서 깬다.
  it("still recognizes every consumer's connect payload", () => {
    const counted = CONSUMERS.map((relativePath) => {
      const source = readFileSync(resolve(here, relativePath), "utf8");
      return [relativePath, sshConnectPayloads(source).length] as const;
    });

    expect(counted.filter(([, count]) => count === 0)).toEqual([]);
  });
});

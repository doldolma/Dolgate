import { describe, expect, it } from "vitest";
import {
  countHostsUsingSnippet,
  hasSnippetVariables,
  parseSnippetVariables,
  resolveSnippetCommand,
} from "./snippet";

describe("parseSnippetVariables", () => {
  it("returns [] when there are no variables", () => {
    expect(parseSnippetVariables("ls -la")).toEqual([]);
  });

  it("extracts variables in order, de-duplicated", () => {
    expect(
      parseSnippetVariables("deploy {{svc}} to {{env}} (re-check {{svc}})"),
    ).toEqual([
      { name: "svc", defaultValue: "" },
      { name: "env", defaultValue: "" },
    ]);
  });

  it("captures default values and trims them", () => {
    expect(parseSnippetVariables("kubectl -n {{ns= default }} get pods")).toEqual([
      { name: "ns", defaultValue: "default" },
    ]);
  });

  it("adopts a default from any occurrence of the same variable", () => {
    expect(parseSnippetVariables("{{x}} then {{x=foo}}")).toEqual([
      { name: "x", defaultValue: "foo" },
    ]);
  });
});

describe("hasSnippetVariables", () => {
  it("detects presence/absence", () => {
    expect(hasSnippetVariables("echo {{x}}")).toBe(true);
    expect(hasSnippetVariables("echo hi")).toBe(false);
  });

  it("is repeatable (no global-regex lastIndex leak)", () => {
    expect(hasSnippetVariables("echo {{x}}")).toBe(true);
    expect(hasSnippetVariables("echo {{x}}")).toBe(true);
  });
});

describe("resolveSnippetCommand", () => {
  it("substitutes provided values", () => {
    expect(
      resolveSnippetCommand("deploy {{svc}} to {{env}}", {
        svc: "web",
        env: "prod",
      }),
    ).toBe("deploy web to prod");
  });

  it("falls back to the default when a value is missing", () => {
    expect(resolveSnippetCommand("kubectl -n {{ns=default}} get", {})).toBe(
      "kubectl -n default get",
    );
  });

  it("uses an empty string when there is no value and no default", () => {
    expect(resolveSnippetCommand("echo {{x}}", {})).toBe("echo ");
  });

  it("prefers a provided value over the default", () => {
    expect(resolveSnippetCommand("-n {{ns=default}}", { ns: "kube-system" })).toBe(
      "-n kube-system",
    );
  });

  it("replaces repeated occurrences", () => {
    expect(resolveSnippetCommand("{{x}}-{{x}}", { x: "a" })).toBe("a-a");
  });
});

// /g 정규식을 모듈 전역으로 공유하면 test()가 남긴 lastIndex 를 matchAll 이 복제해 가
// 앞쪽 변수를 놓친다. 그러면 그 변수는 치환되지 않은 "{{user}}" 그대로 셸에 나간다.
// 테스트 파일 안의 선언 순서가 이 결함을 우연히 가리고 있었다(셔플 실행에서 드러남).
describe("호출 순서에 상태가 남지 않는다", () => {
  const command = "ssh {{user}}@{{host}} -p {{port}}";

  it("hasSnippetVariables 뒤에 불러도 변수를 다 찾는다", () => {
    expect(hasSnippetVariables(command)).toBe(true);
    expect(parseSnippetVariables(command).map((v) => v.name)).toEqual([
      "user",
      "host",
      "port",
    ]);
  });

  it("hasSnippetVariables 뒤에 치환해도 빠지는 변수가 없다", () => {
    expect(hasSnippetVariables(command)).toBe(true);
    expect(
      resolveSnippetCommand(command, { user: "root", host: "h", port: "22" }),
    ).toBe("ssh root@h -p 22");
  });

  it("연달아 여러 번 호출해도 결과가 같다", () => {
    const first = parseSnippetVariables(command).map((v) => v.name);
    hasSnippetVariables(command);
    parseSnippetVariables(command);
    expect(parseSnippetVariables(command).map((v) => v.name)).toEqual(first);
  });
});

describe('countHostsUsingSnippet', () => {
  // 스니펫을 지우면 이 호스트들의 시작 명령이 함께 풀린다(removeSnippet). 지우기 전에 몇 개가
  // 풀리는지 보여 주려고 센다.
  const hosts = [
    { id: 'h1', kind: 'ssh', startupCommand: { type: 'snippet', snippetId: 's1' } },
    { id: 'h2', kind: 'ssh', startupCommand: { type: 'snippet', snippetId: 's2' } },
    { id: 'h3', kind: 'ssh', startupCommand: { type: 'command', command: 'htop' } },
    { id: 'h4', kind: 'ssh', startupCommand: null },
    { id: 'h5', kind: 'ssh' },
    // 시작 명령이라는 개념이 없는 종류. 속성 자체가 없어도 터지지 않아야 한다.
    { id: 'h6', kind: 'rdp' },
  ] as unknown as Parameters<typeof countHostsUsingSnippet>[0];

  it('그 스니펫을 시작 명령으로 쓰는 것만 센다', () => {
    expect(countHostsUsingSnippet(hosts, 's1')).toBe(1);
    expect(countHostsUsingSnippet(hosts, 's2')).toBe(1);
  });

  it('쓰는 곳이 없으면 0', () => {
    expect(countHostsUsingSnippet(hosts, 'nobody')).toBe(0);
    expect(countHostsUsingSnippet([], 's1')).toBe(0);
  });
});

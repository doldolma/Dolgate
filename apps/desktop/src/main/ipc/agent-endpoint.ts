import { execFile, spawn } from "node:child_process";
import os from "node:os";
import type { AgentForwardingEndpointKind, SshAgentProbeResult } from "@shared";

// 로컬 ssh-agent(포워딩·인증 공용)의 소켓/파이프 엔드포인트.
export interface LocalAgentEndpoint {
  kind: AgentForwardingEndpointKind;
  endpoint: string;
}

function execFileText(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

// 로그인 셸을 띄워 출력을 캡처한다. stdin/stderr는 무시해 hang·job-control 노이즈를 막고,
// 타임아웃 시 SIGKILL. 실패/타임아웃이면 지금까지의 stdout(또는 빈 문자열)을 돌려준다.
function runShellCapture(
  shellPath: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const finish = (value: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shellPath, args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve("");
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // 이미 종료됐으면 무시.
      }
      finish(stdout);
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.on("error", () => finish(""));
    child.on("close", () => finish(stdout));
  });
}

// 사용자의 기본 로그인 셸. process.env.SHELL은 GUI 실행 시 비어있을 수 있어 OS 조회로 폴백.
async function resolveDefaultShell(platform: NodeJS.Platform): Promise<string> {
  const fromEnv = process.env.SHELL?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  let username = "";
  try {
    username = os.userInfo().username;
  } catch {
    username = "";
  }
  if (platform === "darwin" && username) {
    const out = await execFileText(
      "dscl",
      [".", "-read", `/Users/${username}`, "UserShell"],
      1500,
    ).catch(() => "");
    const match = /UserShell:\s*(\S+)/.exec(out);
    if (match?.[1]) {
      return match[1];
    }
  } else if (platform === "linux" && username) {
    const out = await execFileText("getent", ["passwd", username], 1500).catch(
      () => "",
    );
    const shell = out.trim().split(":")[6];
    if (shell) {
      return shell;
    }
  }
  return "/bin/sh";
}

let cachedShellSock: string | null | undefined;

// 로그인 셸이 실제로 보는 SSH_AUTH_SOCK. GUI 앱은 셸 프로필(.zshrc 등)의 export를 상속받지
// 못하므로, 기본 셸을 로그인+인터랙티브로 한 번 띄워 값을 읽는다 → 사용자가 프로필에 지정한
// 어떤 agent 소켓(1Password·gpg-agent 등)이든 그대로 잡힌다. 결과는 캐시(프로세스 수명 동안 1회).
export async function resolveShellSshAuthSock(
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  if (platform !== "darwin" && platform !== "linux") {
    return null;
  }
  if (cachedShellSock !== undefined) {
    return cachedShellSock;
  }
  const shellPath = await resolveDefaultShell(platform).catch(() => "/bin/sh");
  const marker = "__DOLGATE_AUTHSOCK__";
  // 마커로 감싸 프롬프트/노이즈와 분리. 로그인(-l)+인터랙티브(-i)로 프로필 소싱.
  const script = `printf %s '${marker}'; printf %s "$SSH_AUTH_SOCK"; printf %s '${marker}'`;
  const out = await runShellCapture(shellPath, ["-lic", script], 4000);
  let value: string | null = null;
  const first = out.indexOf(marker);
  if (first >= 0) {
    const second = out.indexOf(marker, first + marker.length);
    if (second > first) {
      const captured = out.slice(first + marker.length, second).trim();
      value = captured || null;
    }
  }
  cachedShellSock = value;
  return value;
}

export function __resetShellSshAuthSockCacheForTest(): void {
  cachedShellSock = undefined;
}

// 로컬 ssh-agent 엔드포인트 해석(포워딩·인증 공용). darwin/linux 순서:
// 셸 해석값 → process.env.SSH_AUTH_SOCK → launchctl(mac). 셸 해석을 우선해 사용자가 프로필에
// 지정한 agent(1Password 등)를 GUI 실행에서도 정확히 잡는다. Windows는 openssh 파이프.
export async function resolveLocalAgentEndpoint(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  runLaunchctl: (key: string) => Promise<string | null> = async (key) => {
    if (platform !== "darwin") {
      return null;
    }
    const output = await execFileText(
      "launchctl",
      ["getenv", key],
      1500,
    ).catch(() => "");
    return output.trim() || null;
  },
  resolveShellSock: (
    p: NodeJS.Platform,
  ) => Promise<string | null> = resolveShellSshAuthSock,
): Promise<LocalAgentEndpoint | null> {
  if (platform === "win32") {
    return {
      kind: "windows-openssh-pipe",
      endpoint: "\\\\.\\pipe\\openssh-ssh-agent",
    };
  }

  if (platform === "darwin" || platform === "linux") {
    const fromShell = (await resolveShellSock(platform).catch(() => null))?.trim();
    if (fromShell) {
      return { kind: "unix", endpoint: fromShell };
    }
    const fromProcess = env.SSH_AUTH_SOCK?.trim();
    if (fromProcess) {
      return { kind: "unix", endpoint: fromProcess };
    }
    if (platform === "darwin") {
      const fromLaunchctl = (await runLaunchctl("SSH_AUTH_SOCK"))?.trim();
      if (fromLaunchctl) {
        return { kind: "unix", endpoint: fromLaunchctl };
      }
    }
    return null;
  }

  return null;
}

// ── SSH Agent 상태 프로브 (설정 시점 HostForm 표시용) ──────────────────────────

function resolveSshAddPath(platform: NodeJS.Platform): string {
  // 시스템 OpenSSH의 ssh-add(어떤 agent 소켓이든 조회 가능). GUI PATH를 못 믿으니 unix는 절대경로.
  if (platform === "darwin" || platform === "linux") {
    return "/usr/bin/ssh-add";
  }
  return "ssh-add";
}

function runSshAddList(
  sshAddPath: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ exitCode: number | null; stdout: string; missing: boolean }> {
  return new Promise((resolve) => {
    execFile(sshAddPath, ["-l"], { timeout: timeoutMs, env }, (error, stdout) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          resolve({ exitCode: null, stdout: "", missing: true });
          return;
        }
        resolve({
          exitCode: typeof code === "number" ? code : 1,
          stdout: stdout ?? "",
          missing: false,
        });
        return;
      }
      resolve({ exitCode: 0, stdout: stdout ?? "", missing: false });
    });
  });
}

// 로컬 ssh-agent 상태 조회. resolveLocalAgentEndpoint로 소켓을 찾고 ssh-add -l로 키를 센다
// (1Password 등 어떤 agent든 소켓만 맞으면 조회됨). ssh-add가 없거나 실패하면 "unknown"으로
// 폴백 — 실제 인증은 Go가 agent에 직접 붙으므로 프로브 실패가 인증을 막지 않는다.
export async function probeLocalAgent(
  platform: NodeJS.Platform = process.platform,
): Promise<SshAgentProbeResult> {
  const endpoint = await resolveLocalAgentEndpoint(platform);
  if (!endpoint) {
    return { status: "not-found" };
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (endpoint.kind === "unix") {
    env.SSH_AUTH_SOCK = endpoint.endpoint;
  }
  const { exitCode, stdout, missing } = await runSshAddList(
    resolveSshAddPath(platform),
    env,
    4000,
  );
  if (missing) {
    return { status: "unknown", endpoint: endpoint.endpoint };
  }
  if (exitCode === 0) {
    const keyCount = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0).length;
    return {
      status: keyCount > 0 ? "ok" : "empty",
      keyCount,
      endpoint: endpoint.endpoint,
    };
  }
  if (exitCode === 1) {
    // ssh-add: "The agent has no identities." — 실행 중이나 키 없음.
    return { status: "empty", keyCount: 0, endpoint: endpoint.endpoint };
  }
  // exit 2 등: agent 연결 불가.
  return { status: "unreachable", endpoint: endpoint.endpoint };
}

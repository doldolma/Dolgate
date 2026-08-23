// 주소를 직접 쳐서 붙는 즉석 SSH 접속.
//
// 데스크톱 명령 팔레트와 모바일 검색이 함께 쓴다 — 같은 문자열을 두 곳이 다르게 해석하면
// 한쪽에서만 되는 주소가 생긴다.

import { isSshHostRecord } from './models';
import type { HostRecord } from './models';
import { normalizeGroupPath } from './group-paths';

export interface ParsedQuickSshCommand {
  username: string;
  hostname: string;
  port: number;
}

function splitCommandTokens(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (!quote && /\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote === char ? null : char;
      continue;
    }
    current += char;
  }

  if (quote) {
    return [];
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function parsePort(value: string): number | null {
  if (!/^\d{1,5}$/.test(value)) {
    return null;
  }
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function parseHostPort(value: string): { hostname: string; port: number } | null {
  let hostname = value;
  let port = 22;

  if (value.startsWith('[')) {
    const closeIndex = value.indexOf(']');
    if (closeIndex <= 1) {
      return null;
    }
    hostname = value.slice(1, closeIndex);
    const rest = value.slice(closeIndex + 1);
    if (rest) {
      if (!rest.startsWith(':')) {
        return null;
      }
      const parsedPort = parsePort(rest.slice(1));
      if (!parsedPort) {
        return null;
      }
      port = parsedPort;
    }
  } else {
    const colonIndex = value.lastIndexOf(':');
    if (colonIndex > 0 && value.indexOf(':') === colonIndex) {
      const parsedPort = parsePort(value.slice(colonIndex + 1));
      if (!parsedPort) {
        return null;
      }
      hostname = value.slice(0, colonIndex);
      port = parsedPort;
    }
  }

  const trimmedHost = hostname.trim();
  if (!trimmedHost || /[\s/]/.test(trimmedHost)) {
    return null;
  }
  return { hostname: trimmedHost, port };
}

export function parseQuickSshCommand(input: string): ParsedQuickSshCommand | null {
  const tokens = splitCommandTokens(input.trim());
  if (tokens.length < 2 || tokens[0] !== 'ssh') {
    return null;
  }

  let port = 22;
  let hasExplicitPortOption = false;
  let target: string | null = null;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '-p') {
      const next = tokens[index + 1];
      if (!next) {
        return null;
      }
      const parsedPort = parsePort(next);
      if (!parsedPort) {
        return null;
      }
      port = parsedPort;
      hasExplicitPortOption = true;
      index += 1;
      continue;
    }
    if (token.startsWith('-p') && token.length > 2) {
      const parsedPort = parsePort(token.slice(2));
      if (!parsedPort) {
        return null;
      }
      port = parsedPort;
      hasExplicitPortOption = true;
      continue;
    }
    if (token.startsWith('-')) {
      return null;
    }
    if (target) {
      return null;
    }
    target = token;
  }

  if (!target) {
    return null;
  }

  const atIndex = target.indexOf('@');
  if (atIndex <= 0 || atIndex !== target.lastIndexOf('@')) {
    return null;
  }

  const username = target.slice(0, atIndex).trim();
  const hostPort = parseHostPort(target.slice(atIndex + 1));
  if (!username || /[\s/]/.test(username) || !hostPort) {
    return null;
  }

  return {
    username,
    hostname: hostPort.hostname,
    port: hasExplicitPortOption ? port : hostPort.port,
  };
}

/**
 * 접두사 없는 주소를 읽는다 — `user@host` · `user@host:2222`.
 *
 * `parseQuickSshCommand` 와 따로 두는 이유: 그쪽은 `ssh -p 22 user@host` 처럼 옵션까지 읽는
 * 명령 문법이고, 거기에 접두사 없는 형태를 섞으면 기존 해석이 흔들린다. 여기서는 주소 하나만 본다.
 *
 * **`host` 단독은 일부러 거절한다.** 검색창에서 호스트 이름을 치는 것과 구분할 수 없어서,
 * 받아들이면 이름을 칠 때마다 "접속" 항목이 뜬다. `@` 가 있어야 주소로 친 것이 분명하다.
 */
export function parseQuickSshTarget(input: string): ParsedQuickSshCommand | null {
  const trimmed = input.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    return null;
  }

  const atIndex = trimmed.indexOf('@');
  if (atIndex <= 0 || atIndex !== trimmed.lastIndexOf('@')) {
    return null;
  }

  const username = trimmed.slice(0, atIndex);
  const hostPort = parseHostPort(trimmed.slice(atIndex + 1));
  if (!username || /[\s/]/.test(username) || !hostPort) {
    return null;
  }

  return { username, hostname: hostPort.hostname, port: hostPort.port };
}

/** 명령 형태(`ssh …`)와 주소 형태(`user@host`)를 모두 받아들인다. */
export function parseQuickSshInput(input: string): ParsedQuickSshCommand | null {
  return parseQuickSshCommand(input) ?? parseQuickSshTarget(input);
}

export function formatQuickSshHostLabel(input: ParsedQuickSshCommand): string {
  const host = input.hostname.includes(':') ? `[${input.hostname}]` : input.hostname;
  return input.port === 22 ? `${input.username}@${host}` : `${input.username}@${host}:${input.port}`;
}

export function buildQuickSshHostLabel(
  input: ParsedQuickSshCommand,
  hosts: HostRecord[],
  groupName: string | null,
): string {
  const baseLabel = formatQuickSshHostLabel(input);
  const groupPath = normalizeGroupPath(groupName);
  const labelsInGroup = new Set(
    hosts
      .filter((host) => normalizeGroupPath(host.groupName) === groupPath)
      .map((host) => host.label),
  );

  if (!labelsInGroup.has(baseLabel)) {
    return baseLabel;
  }

  const firstCopyLabel = `${baseLabel} Copy`;
  if (!labelsInGroup.has(firstCopyLabel)) {
    return firstCopyLabel;
  }

  let suffix = 2;
  while (labelsInGroup.has(`${baseLabel} Copy ${suffix}`)) {
    suffix += 1;
  }
  return `${baseLabel} Copy ${suffix}`;
}

export function findExistingQuickSshHost(
  input: ParsedQuickSshCommand,
  hosts: HostRecord[],
): Extract<HostRecord, { kind: 'ssh' }> | null {
  const targetHost = input.hostname.toLocaleLowerCase();
  const found = hosts.find(
    (host): host is Extract<HostRecord, { kind: 'ssh' }> =>
      isSshHostRecord(host) &&
      host.username === input.username &&
      host.port === input.port &&
      host.hostname.toLocaleLowerCase() === targetHost,
  );
  return found ?? null;
}

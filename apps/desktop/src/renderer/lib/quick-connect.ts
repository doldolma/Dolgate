import { isSshHostRecord, normalizeGroupPath } from '@shared';
import type { HostRecord } from '@shared';

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

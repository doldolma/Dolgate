import { randomUUID } from 'node:crypto';
import { access, readFile, readdir, realpath } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  OpenSshHostPreview,
  OpenSshImportWarning,
  OpenSshProbeResult,
  OpenSshSnapshotFileInput,
  OpenSshSourceOrigin,
  OpenSshSourceSummary,
} from '@shared';

interface OpenSshConfigLine {
  filePath: string;
  lineNumber: number;
  text: string;
}

interface ParsedOpenSshHost {
  key: string;
  alias: string;
  hostname: string;
  port: number;
  username: string;
  authType: 'password' | 'privateKey';
  identityFilePath: string | null;
  sourceFilePath: string;
  sourceLine: number;
  duplicateKey: string;
}

interface ParsedOpenSshSource {
  source: OpenSshSourceSummary;
  hosts: ParsedOpenSshHost[];
  warnings: OpenSshImportWarning[];
}

interface OpenSshSnapshot {
  sources: OpenSshSourceSummary[];
  hostsByKey: Map<string, ParsedOpenSshHost>;
  warnings: OpenSshImportWarning[];
  seenDuplicateKeys: Set<string>;
  seenSourcePaths: Set<string>;
  skippedExistingHostCount: number;
  skippedDuplicateHostCount: number;
}

interface MutableHostBlock {
  alias: string;
  hostname: string | null;
  username: string | null;
  port: number | null;
  identityFilePath: string | null;
  sourceFilePath: string;
  sourceLine: number;
}

function toWarning(
  message: string,
  code: string | null = null,
  filePath: string | null = null,
  lineNumber: number | null = null,
): OpenSshImportWarning {
  return {
    code,
    message,
    filePath,
    lineNumber,
  };
}

function buildSshDuplicateKey(
  hostname: string,
  port: number,
  username: string,
): string {
  return `${hostname}\u0000${port}\u0000${username}`;
}

function expandHomePath(value: string, homeDirectory: string): string {
  if (!value.startsWith('~')) {
    return value;
  }
  if (value === '~') {
    return homeDirectory;
  }
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(homeDirectory, value.slice(2));
  }
  return value;
}

function stripInlineComment(line: string): string {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let result = '';

  for (const character of line) {
    if (escaped) {
      result += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      result += character;
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      }
      result += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      result += character;
      continue;
    }
    if (character === '#') {
      break;
    }
    result += character;
  }

  return result.trim();
}

function parseDirective(line: string): { key: string; value: string } | null {
  const normalized = stripInlineComment(line);
  if (!normalized) {
    return null;
  }

  const equalsIndex = normalized.indexOf('=');
  const whitespaceMatch = normalized.match(/\s/);
  const whitespaceIndex = whitespaceMatch ? whitespaceMatch.index ?? -1 : -1;

  let splitIndex = -1;
  if (equalsIndex >= 0 && whitespaceIndex >= 0) {
    splitIndex = Math.min(equalsIndex, whitespaceIndex);
  } else if (equalsIndex >= 0) {
    splitIndex = equalsIndex;
  } else {
    splitIndex = whitespaceIndex;
  }

  if (splitIndex < 0) {
    return {
      key: normalized,
      value: '',
    };
  }

  const key = normalized.slice(0, splitIndex).trim();
  const value = normalized.slice(splitIndex + 1).trim().replace(/^=\s*/, '');
  return key ? { key, value } : null;
}

function tokenizeDirectiveValue(value: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (const character of value) {
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += character;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function hasGlobMagic(value: string): boolean {
  return /[*?\[]/.test(value);
}

function globSegmentToRegExp(segment: string): RegExp {
  let pattern = '^';

  for (const character of segment) {
    if (character === '*') {
      pattern += '[^\\\\/]*';
      continue;
    }
    if (character === '?') {
      pattern += '[^\\\\/]';
      continue;
    }
    pattern += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }

  pattern += '$';
  return new RegExp(pattern);
}

async function expandGlobPattern(absolutePattern: string): Promise<string[]> {
  const root = path.parse(absolutePattern).root;
  const relativePattern = absolutePattern.slice(root.length);
  const segments = relativePattern.split(/[\\/]+/).filter(Boolean);
  const matches: string[] = [];

  async function walk(currentPath: string, index: number): Promise<void> {
    if (index >= segments.length) {
      try {
        await access(currentPath, fsConstants.F_OK);
        matches.push(currentPath);
      } catch {
        return;
      }
      return;
    }

    const segment = segments[index];
    if (!hasGlobMagic(segment)) {
      await walk(path.join(currentPath, segment), index + 1);
      return;
    }

    let entries: string[];
    try {
      entries = await readdir(currentPath);
    } catch {
      return;
    }

    const matcher = globSegmentToRegExp(segment);
    const children = entries
      .filter((entry) => matcher.test(entry))
      .sort((left, right) => left.localeCompare(right));
    for (const child of children) {
      await walk(path.join(currentPath, child), index + 1);
    }
  }

  await walk(root || path.sep, 0);
  return matches;
}

async function resolveIncludeTargets(
  patternValue: string,
  baseDir: string,
  homeDirectory: string,
): Promise<string[]> {
  const normalizedPattern = expandHomePath(patternValue, homeDirectory);
  const absolutePattern = path.isAbsolute(normalizedPattern)
    ? path.normalize(normalizedPattern)
    : path.resolve(baseDir, normalizedPattern);
  if (!hasGlobMagic(absolutePattern)) {
    return [absolutePattern];
  }
  return expandGlobPattern(absolutePattern);
}

function isImportableHostPattern(pattern: string): boolean {
  return !pattern.startsWith('!') && !/[*?\[]/.test(pattern);
}

function buildHostKey(alias: string, filePath: string, lineNumber: number): string {
  return `${filePath}\u0000${lineNumber}\u0000${alias}`;
}

function buildSourceId(filePath: string): string {
  return `source:${filePath}`;
}

function formatSourceLabel(
  filePath: string,
  origin: OpenSshSourceOrigin,
  homeDirectory: string,
): string {
  const normalizedHome = path.resolve(homeDirectory);
  const normalizedFile = path.resolve(filePath);
  if (
    origin === 'default-ssh-dir' &&
    normalizedFile === path.join(normalizedHome, '.ssh', 'config')
  ) {
    return '~/.ssh/config';
  }

  if (normalizedFile.startsWith(`${normalizedHome}${path.sep}`)) {
    return `~${normalizedFile.slice(normalizedHome.length)}`;
  }

  return path.basename(filePath);
}

function looksLikeSupportedPrivateKeyPem(privateKeyPem: string): boolean {
  const normalized = privateKeyPem.trim();
  if (!normalized || normalized.startsWith('PuTTY-User-Key-File-')) {
    return false;
  }

  return /-----BEGIN (OPENSSH |RSA |DSA |EC )?PRIVATE KEY-----/.test(
    normalized,
  );
}

async function flattenConfigLines(
  filePath: string,
  warnings: OpenSshImportWarning[],
  visited: Set<string>,
  stack: Set<string>,
  homeDirectory: string,
): Promise<OpenSshConfigLine[]> {
  const absoluteFilePath = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(filePath);
  let realFilePath = absoluteFilePath;
  try {
    realFilePath = await realpath(absoluteFilePath);
  } catch {
    // Preserve the original path so the caller can surface the requested location.
  }

  if (stack.has(realFilePath)) {
    warnings.push(
      toWarning(
        `${absoluteFilePath}에서 순환 Include를 건너뛰었습니다.`,
        'include-cycle',
        absoluteFilePath,
      ),
    );
    return [];
  }
  if (visited.has(realFilePath)) {
    return [];
  }

  let raw: string;
  try {
    raw = await readFile(absoluteFilePath, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `OpenSSH 설정 파일을 읽지 못했습니다: ${absoluteFilePath} (${reason})`,
    );
  }

  visited.add(realFilePath);
  stack.add(realFilePath);
  const baseDir = path.dirname(absoluteFilePath);
  const result: OpenSshConfigLine[] = [];

  try {
    const lines = raw.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const lineNumber = index + 1;
      const directive = parseDirective(lines[index]);
      if (directive?.key.toLowerCase() === 'include') {
        const patterns = tokenizeDirectiveValue(directive.value);
        for (const includePattern of patterns) {
          const matches = await resolveIncludeTargets(
            includePattern,
            baseDir,
            homeDirectory,
          );
          if (matches.length === 0) {
            warnings.push(
              toWarning(
                `Include 패턴과 일치하는 파일이 없습니다: ${includePattern}`,
                'include-not-found',
                absoluteFilePath,
                lineNumber,
              ),
            );
            continue;
          }
          for (const match of matches) {
            try {
              result.push(
                ...(await flattenConfigLines(
                  match,
                  warnings,
                  visited,
                  stack,
                  homeDirectory,
                )),
              );
            } catch (error) {
              warnings.push(
                toWarning(
                  error instanceof Error
                    ? error.message
                    : `포함된 설정 파일을 읽지 못했습니다: ${match}`,
                  'include-read-failed',
                  absoluteFilePath,
                  lineNumber,
                ),
              );
            }
          }
        }
        continue;
      }

      result.push({
        filePath: absoluteFilePath,
        lineNumber,
        text: lines[index],
      });
    }
  } finally {
    stack.delete(realFilePath);
  }

  return result;
}

function finalizeHostBlock(
  hostBlock: MutableHostBlock | null,
  hostsByKey: Map<string, ParsedOpenSshHost>,
  warnings: OpenSshImportWarning[],
): void {
  if (!hostBlock) {
    return;
  }

  const username = hostBlock.username?.trim();
  if (!username) {
    warnings.push(
      toWarning(
        `"${hostBlock.alias}" 항목은 User가 없어 가져오지 않았습니다.`,
        'missing-user',
        hostBlock.sourceFilePath,
        hostBlock.sourceLine,
      ),
    );
    return;
  }

  const hostname = hostBlock.hostname?.trim() || hostBlock.alias;
  const port = hostBlock.port ?? 22;
  const authType = hostBlock.identityFilePath ? 'privateKey' : 'password';
  const key = buildHostKey(
    hostBlock.alias,
    hostBlock.sourceFilePath,
    hostBlock.sourceLine,
  );

  hostsByKey.set(key, {
    key,
    alias: hostBlock.alias,
    hostname,
    port,
    username,
    authType,
    identityFilePath: hostBlock.identityFilePath,
    sourceFilePath: hostBlock.sourceFilePath,
    sourceLine: hostBlock.sourceLine,
    duplicateKey: buildSshDuplicateKey(hostname, port, username),
  });
}

async function buildParsedSource(
  filePath: string,
  origin: OpenSshSourceOrigin,
  homeDirectory: string,
): Promise<ParsedOpenSshSource> {
  const warnings: OpenSshImportWarning[] = [];
  const absoluteFilePath = path.resolve(filePath);
  const lines = await flattenConfigLines(
    absoluteFilePath,
    warnings,
    new Set<string>(),
    new Set<string>(),
    homeDirectory,
  );
  const hostsByKey = new Map<string, ParsedOpenSshHost>();
  let currentHostBlock: MutableHostBlock | null = null;
  let ignoreConditionalBlock = false;

  for (const line of lines) {
    const directive = parseDirective(line.text);
    if (!directive) {
      continue;
    }

    const key = directive.key.toLowerCase();
    if (key === 'match') {
      finalizeHostBlock(currentHostBlock, hostsByKey, warnings);
      currentHostBlock = null;
      ignoreConditionalBlock = true;
      continue;
    }

    if (key === 'host') {
      finalizeHostBlock(currentHostBlock, hostsByKey, warnings);
      ignoreConditionalBlock = false;
      const alias =
        tokenizeDirectiveValue(directive.value).find(isImportableHostPattern) ??
        null;
      if (!alias) {
        currentHostBlock = null;
        warnings.push(
          toWarning(
            '구체적인 별칭이 없는 Host 블록은 가져오지 않았습니다.',
            'unsupported-host-pattern',
            line.filePath,
            line.lineNumber,
          ),
        );
        continue;
      }

      currentHostBlock = {
        alias,
        hostname: null,
        username: null,
        port: null,
        identityFilePath: null,
        sourceFilePath: line.filePath,
        sourceLine: line.lineNumber,
      };
      continue;
    }

    if (ignoreConditionalBlock || !currentHostBlock) {
      continue;
    }

    if (key === 'hostname') {
      currentHostBlock.hostname = directive.value.trim() || null;
      continue;
    }

    if (key === 'user') {
      currentHostBlock.username = directive.value.trim() || null;
      continue;
    }

    if (key === 'port') {
      const parsedPort = Number.parseInt(directive.value.trim(), 10);
      if (Number.isFinite(parsedPort) && parsedPort > 0) {
        currentHostBlock.port = parsedPort;
      } else {
        warnings.push(
          toWarning(
            `"${currentHostBlock.alias}"의 Port 값 "${directive.value.trim()}"는 잘못되어 무시했습니다.`,
            'invalid-port',
            line.filePath,
            line.lineNumber,
          ),
        );
      }
      continue;
    }

    if (key === 'identityfile' && !currentHostBlock.identityFilePath) {
      const identityToken = tokenizeDirectiveValue(directive.value)[0];
      if (!identityToken) {
        continue;
      }
      const expandedIdentity = expandHomePath(identityToken, homeDirectory);
      currentHostBlock.identityFilePath = path.isAbsolute(expandedIdentity)
        ? path.normalize(expandedIdentity)
        : path.resolve(path.dirname(line.filePath), expandedIdentity);
    }
  }

  finalizeHostBlock(currentHostBlock, hostsByKey, warnings);

  return {
    source: {
      id: buildSourceId(absoluteFilePath),
      filePath: absoluteFilePath,
      origin,
      label: formatSourceLabel(absoluteFilePath, origin, homeDirectory),
    },
    hosts: [...hostsByKey.values()],
    warnings,
  };
}

function createEmptySnapshot(): OpenSshSnapshot {
  return {
    sources: [],
    hostsByKey: new Map<string, ParsedOpenSshHost>(),
    warnings: [],
    seenDuplicateKeys: new Set<string>(),
    seenSourcePaths: new Set<string>(),
    skippedExistingHostCount: 0,
    skippedDuplicateHostCount: 0,
  };
}

function buildProbeResult(
  snapshotId: string,
  snapshot: OpenSshSnapshot,
): OpenSshProbeResult {
  return {
    snapshotId,
    sources: [...snapshot.sources],
    hosts: [...snapshot.hostsByKey.values()].map((host) => ({
      key: host.key,
      alias: host.alias,
      hostname: host.hostname,
      port: host.port,
      username: host.username,
      authType: host.authType,
      identityFilePath: host.identityFilePath,
      sourceFilePath: host.sourceFilePath,
      sourceLine: host.sourceLine,
    })),
    warnings: [...snapshot.warnings],
    skippedExistingHostCount: snapshot.skippedExistingHostCount,
    skippedDuplicateHostCount: snapshot.skippedDuplicateHostCount,
  };
}

function mergeParsedSource(
  snapshot: OpenSshSnapshot,
  parsedSource: ParsedOpenSshSource,
  existingDuplicateKeys: ReadonlySet<string>,
): void {
  snapshot.warnings.push(...parsedSource.warnings);

  if (!snapshot.seenSourcePaths.has(parsedSource.source.filePath)) {
    snapshot.sources.push(parsedSource.source);
    snapshot.seenSourcePaths.add(parsedSource.source.filePath);
  }

  for (const host of parsedSource.hosts) {
    if (existingDuplicateKeys.has(host.duplicateKey)) {
      snapshot.skippedExistingHostCount += 1;
      continue;
    }
    if (snapshot.seenDuplicateKeys.has(host.duplicateKey)) {
      snapshot.skippedDuplicateHostCount += 1;
      continue;
    }

    snapshot.seenDuplicateKeys.add(host.duplicateKey);
    snapshot.hostsByKey.set(host.key, host);
  }
}

export async function resolveOpenSshIdentityImport(
  identityFilePath: string,
): Promise<
  | { kind: 'managed-key'; privateKeyPem: string }
  | { kind: 'path-fallback'; warning: OpenSshImportWarning }
> {
  try {
    const privateKeyPem = await readFile(identityFilePath, 'utf8');
    if (!looksLikeSupportedPrivateKeyPem(privateKeyPem)) {
      return {
        kind: 'path-fallback',
        warning: toWarning(
          `${path.basename(identityFilePath)} 키는 지원되지 않는 형식이라 경로만 가져왔습니다.`,
          'unsupported-key-format',
          identityFilePath,
        ),
      };
    }

    return {
      kind: 'managed-key',
      privateKeyPem,
    };
  } catch {
    return {
      kind: 'path-fallback',
      warning: toWarning(
        `${path.basename(identityFilePath)} 키 파일을 읽지 못해 경로만 가져왔습니다.`,
        'identity-read-failed',
        identityFilePath,
      ),
    };
  }
}

export class OpenSshImportService {
  private readonly snapshots = new Map<string, OpenSshSnapshot>();

  constructor(private readonly homeDirectory = os.homedir()) {}

  private createSnapshot(): { snapshotId: string; snapshot: OpenSshSnapshot } {
    const snapshotId = randomUUID();
    const snapshot = createEmptySnapshot();
    this.snapshots.set(snapshotId, snapshot);
    return {
      snapshotId,
      snapshot,
    };
  }

  async probeDefault(
    existingDuplicateKeys: ReadonlySet<string>,
  ): Promise<OpenSshProbeResult> {
    const { snapshotId, snapshot } = this.createSnapshot();
    const defaultConfigPath = path.join(this.homeDirectory, '.ssh', 'config');

    try {
      await access(defaultConfigPath, fsConstants.F_OK);
      const parsedSource = await buildParsedSource(
        defaultConfigPath,
        'default-ssh-dir',
        this.homeDirectory,
      );
      mergeParsedSource(snapshot, parsedSource, existingDuplicateKeys);
    } catch (error) {
      if (error instanceof Error) {
        const code =
          'code' in error
            ? String((error as NodeJS.ErrnoException).code ?? '')
            : '';
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          return buildProbeResult(snapshotId, snapshot);
        }
      }
      this.snapshots.delete(snapshotId);
      throw error;
    }

    return buildProbeResult(snapshotId, snapshot);
  }

  async addFileToSnapshot(
    input: OpenSshSnapshotFileInput,
    existingDuplicateKeys: ReadonlySet<string>,
  ): Promise<OpenSshProbeResult> {
    const snapshot = this.snapshots.get(input.snapshotId);
    if (!snapshot) {
      throw new Error(
        'OpenSSH 가져오기 상태를 찾을 수 없습니다. 다이얼로그를 다시 열어 주세요.',
      );
    }

    const parsedSource = await buildParsedSource(
      input.filePath,
      'manual-file',
      this.homeDirectory,
    );
    mergeParsedSource(snapshot, parsedSource, existingDuplicateKeys);
    return buildProbeResult(input.snapshotId, snapshot);
  }

  getSnapshot(snapshotId: string): OpenSshSnapshot | null {
    return this.snapshots.get(snapshotId) ?? null;
  }

  discardSnapshot(snapshotId: string): void {
    this.snapshots.delete(snapshotId);
  }
}

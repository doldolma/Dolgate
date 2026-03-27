import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  normalizeGroupPath,
  type XshellImportGroupPreview,
  type XshellImportHostPreview,
  type XshellImportSelectionInput,
  type XshellImportWarning,
  type XshellProbeResult,
  type XshellSnapshotFolderInput,
  type XshellSourceOrigin,
  type XshellSourceSummary
} from '@shared';

const SUPPORTED_PROTOCOLS = new Set(['SSH', 'SFTP']);

export interface XshellSnapshotHost {
  key: string;
  label: string;
  hostname: string;
  port: number;
  username: string;
  authType: 'password' | 'privateKey';
  groupPath: string | null;
  privateKeyPath: string | null;
  sourceFilePath: string;
  duplicateKey: string;
  hasPasswordHint: boolean;
  hasAuthProfile: boolean;
}

export interface XshellSnapshot {
  sources: XshellSourceSummary[];
  groupPaths: Set<string>;
  hostsByKey: Map<string, XshellSnapshotHost>;
  warnings: XshellImportWarning[];
  seenDuplicateKeys: Set<string>;
  seenSourcePaths: Set<string>;
  skippedExistingHostCount: number;
  skippedDuplicateHostCount: number;
}

interface ParsedXshellSource {
  source: XshellSourceSummary;
  groupPaths: Set<string>;
  hosts: XshellSnapshotHost[];
  warnings: XshellImportWarning[];
}

function toWarning(
  message: string,
  code: string | null = null,
  filePath: string | null = null
): XshellImportWarning {
  return {
    code,
    message,
    filePath
  };
}

function buildSshDuplicateKey(hostname: string, port: number, username: string): string {
  return `${hostname}\u0000${port}\u0000${username}`;
}

function buildSourceLabel(origin: XshellSourceOrigin, folderPath: string): string {
  return origin === 'default-session-dir' ? '기본 Xshell 세션' : path.basename(folderPath) || folderPath;
}

function buildHostKey(sourceFilePath: string): string {
  return `file:${sourceFilePath}`;
}

function createEmptySnapshot(): XshellSnapshot {
  return {
    sources: [],
    groupPaths: new Set<string>(),
    hostsByKey: new Map<string, XshellSnapshotHost>(),
    warnings: [],
    seenDuplicateKeys: new Set<string>(),
    seenSourcePaths: new Set<string>(),
    skippedExistingHostCount: 0,
    skippedDuplicateHostCount: 0
  };
}

function compareVersionLabels(left: string, right: string): number {
  const leftParts = left.split(/[^0-9]+/).filter(Boolean).map((value) => Number.parseInt(value, 10));
  const rightParts = right.split(/[^0-9]+/).filter(Boolean).map((value) => Number.parseInt(value, 10));
  const maxLength = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }

  return left.localeCompare(right);
}

function buildXshellGroupAncestorPaths(groupPath: string | null | undefined): string[] {
  const normalized = normalizeGroupPath(groupPath);
  if (!normalized) {
    return [];
  }

  const parts = normalized.split('/');
  const paths: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    paths.push(parts.slice(0, index + 1).join('/'));
  }
  return paths;
}

function normalizeSessionFolderPath(rootPath: string, candidatePath: string): string | null {
  const relativePath = path.relative(rootPath, candidatePath);
  if (!relativePath || relativePath === '.') {
    return null;
  }

  return normalizeGroupPath(relativePath.split(path.sep).join('/'));
}

function parseIniSections(raw: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let currentSection = '';
  sections.set(currentSection, new Map<string, string>());

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) {
      continue;
    }

    const sectionMatch = trimmed.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      if (!sections.has(currentSection)) {
        sections.set(currentSection, new Map<string, string>());
      }
      continue;
    }

    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex < 0) {
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim();
    if (!key) {
      continue;
    }

    let section = sections.get(currentSection);
    if (!section) {
      section = new Map<string, string>();
      sections.set(currentSection, section);
    }
    section.set(key, value);
  }

  return sections;
}

function readIniValue(sections: Map<string, Map<string, string>>, sectionName: string, key: string): string {
  return sections.get(sectionName)?.get(key)?.trim() ?? '';
}

function looksLikeUtf16Le(buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.length, 128)
  if (sampleLength < 4) {
    return false
  }

  let zeroCount = 0
  let inspectedBytes = 0
  for (let index = 1; index < sampleLength; index += 2) {
    inspectedBytes += 1
    if (buffer[index] === 0) {
      zeroCount += 1
    }
  }

  return inspectedBytes > 0 && zeroCount / inspectedBytes >= 0.3
}

function decodeSessionFile(raw: Buffer): string {
  if (raw.length === 0) {
    return ''
  }

  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
    return raw.subarray(2).toString('utf16le')
  }

  if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) {
    const swapped = Buffer.from(raw.subarray(2))
    for (let index = 0; index + 1 < swapped.length; index += 2) {
      const current = swapped[index]
      swapped[index] = swapped[index + 1]
      swapped[index + 1] = current
    }
    return swapped.toString('utf16le')
  }

  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    return raw.subarray(3).toString('utf8')
  }

  if (looksLikeUtf16Le(raw)) {
    return raw.toString('utf16le')
  }

  return raw.toString('utf8')
}

function expandWindowsEnvVars(value: string): string {
  return value.replace(/%([^%]+)%/g, (_match, name) => process.env[name] ?? `%${name}%`);
}

async function resolveKeyPath(userKey: string, sessionFilePath: string, sessionRootPath: string): Promise<string | null> {
  const raw = userKey.trim();
  if (!raw) {
    return null;
  }

  const expanded = expandWindowsEnvVars(raw);
  const candidates = new Set<string>();

  if (path.isAbsolute(expanded)) {
    candidates.add(expanded);
  } else {
    candidates.add(path.resolve(path.dirname(sessionFilePath), expanded));
    candidates.add(path.resolve(sessionRootPath, expanded));
  }

  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.F_OK);
      return await realpath(candidate);
    } catch {
      continue;
    }
  }

  return null;
}

async function parseSessionFile(
  sessionFilePath: string,
  sessionRootPath: string
): Promise<{ host: XshellSnapshotHost | null; warnings: XshellImportWarning[] }> {
  const warnings: XshellImportWarning[] = []
  const sourceFilePath = await realpath(sessionFilePath)
  const raw = await readFile(sourceFilePath)
  const sections = parseIniSections(decodeSessionFile(raw))
  const label = path.basename(sourceFilePath, path.extname(sourceFilePath))
  const protocol = readIniValue(sections, 'CONNECTION', 'Protocol').toUpperCase() || 'SSH'

  if (!SUPPORTED_PROTOCOLS.has(protocol)) {
    warnings.push(
      toWarning(
        `${label}: ${protocol} 프로토콜은 가져오기를 지원하지 않아 건너뛰었습니다.`,
        'unsupported-protocol',
        sourceFilePath
      )
    )
    return { host: null, warnings }
  }

  const hostname = readIniValue(sections, 'CONNECTION', 'Host')
  if (!hostname) {
    warnings.push(
      toWarning(
        `${label}: Host 값이 없어 세션을 건너뛰었습니다.`,
        'missing-host',
        sourceFilePath
      )
    )
    return { host: null, warnings }
  }

  const username = readIniValue(sections, 'CONNECTION:AUTHENTICATION', 'UserName')
  if (!username) {
    warnings.push(
      toWarning(
        `${label}: UserName 값이 없어 세션을 건너뛰었습니다.`,
        'missing-username',
        sourceFilePath
      )
    )
    return { host: null, warnings }
  }

  const portValue = readIniValue(sections, 'CONNECTION', 'Port')
  let port = 22
  if (portValue) {
    const parsedPort = Number.parseInt(portValue, 10)
    if (Number.isFinite(parsedPort) && parsedPort > 0) {
      port = parsedPort
    } else {
      warnings.push(
        toWarning(
          `${label}: Port 값 "${portValue}"가 잘못되어 22번 포트를 사용합니다.`,
          'invalid-port',
          sourceFilePath
        )
      )
    }
  }

  const groupPath = normalizeSessionFolderPath(sessionRootPath, path.dirname(sourceFilePath))
  const password = readIniValue(sections, 'CONNECTION:AUTHENTICATION', 'Password')
  const useAuthProfile = readIniValue(sections, 'CONNECTION:AUTHENTICATION', 'UseAuthProfile') === '1'
  const authProfile = readIniValue(sections, 'CONNECTION:AUTHENTICATION', 'AuthProfile')
  const userKey = readIniValue(sections, 'CONNECTION:AUTHENTICATION', 'UserKey')
  const hasPasswordHint = Boolean(password)
  const hasAuthProfile = useAuthProfile || Boolean(authProfile)
  const authType = userKey ? 'privateKey' : 'password'
  let privateKeyPath: string | null = null

  if (userKey) {
    privateKeyPath = await resolveKeyPath(userKey, sourceFilePath, sessionRootPath)
    if (!privateKeyPath) {
      warnings.push(
        toWarning(
          `${label}: UserKey "${userKey}" 경로를 찾지 못해 키 경로 없이 가져옵니다.`,
          'unresolved-user-key',
          sourceFilePath
        )
      )
    }
  }

  if (hasPasswordHint) {
    warnings.push(
      toWarning(
        `${label}: 저장된 Xshell 비밀번호는 현재 버전에서 가져오지 않습니다.`,
        'password-not-imported',
        sourceFilePath
      )
    )
  }

  if (hasAuthProfile) {
    warnings.push(
      toWarning(
        `${label}: Xshell 인증 프로필은 현재 버전에서 가져오지 않습니다.`,
        'auth-profile-not-imported',
        sourceFilePath
      )
    )
  }

  return {
    host: {
      key: buildHostKey(sourceFilePath),
      label,
      hostname,
      port,
      username,
      authType,
      groupPath,
      privateKeyPath,
      sourceFilePath,
      duplicateKey: buildSshDuplicateKey(hostname, port, username),
      hasPasswordHint,
      hasAuthProfile
    },
    warnings
  }
}

async function buildParsedSource(
  folderPath: string,
  origin: XshellSourceOrigin
): Promise<ParsedXshellSource> {
  const resolvedFolderPath = await realpath(path.resolve(folderPath))
  const source: XshellSourceSummary = {
    id: `${origin}:${resolvedFolderPath}`,
    folderPath: resolvedFolderPath,
    origin,
    label: buildSourceLabel(origin, resolvedFolderPath)
  }
  const groupPaths = new Set<string>()
  const hosts: XshellSnapshotHost[] = []
  const warnings: XshellImportWarning[] = []

  async function walk(currentPath: string): Promise<boolean> {
    const entries = (await readdir(currentPath, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))
    let hasImportableSession = false

    for (const entry of entries) {
      const absolutePath = path.join(currentPath, entry.name)
      if (entry.isDirectory()) {
        const childHasImportableSession = await walk(absolutePath)
        const groupPath = normalizeSessionFolderPath(resolvedFolderPath, absolutePath)
        if (childHasImportableSession && groupPath) {
          groupPaths.add(groupPath)
        }
        hasImportableSession = hasImportableSession || childHasImportableSession
        continue
      }

      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.xsh') {
        continue
      }

      const parsed = await parseSessionFile(absolutePath, resolvedFolderPath)
      warnings.push(...parsed.warnings)
      if (!parsed.host) {
        continue
      }

      for (const candidatePath of buildXshellGroupAncestorPaths(parsed.host.groupPath)) {
        groupPaths.add(candidatePath)
      }
      hosts.push(parsed.host)
      hasImportableSession = true
    }

    return hasImportableSession
  }

  await walk(resolvedFolderPath)

  return {
    source,
    groupPaths,
    hosts,
    warnings
  }
}

function mergeParsedSource(
  snapshot: XshellSnapshot,
  parsedSource: ParsedXshellSource,
  existingDuplicateKeys: ReadonlySet<string>
): void {
  snapshot.warnings.push(...parsedSource.warnings)

  if (!snapshot.seenSourcePaths.has(parsedSource.source.folderPath)) {
    snapshot.sources.push(parsedSource.source)
    snapshot.seenSourcePaths.add(parsedSource.source.folderPath)
  }

  for (const groupPath of parsedSource.groupPaths) {
    snapshot.groupPaths.add(groupPath)
  }

  for (const host of parsedSource.hosts) {
    if (existingDuplicateKeys.has(host.duplicateKey)) {
      snapshot.skippedExistingHostCount += 1
      continue
    }
    if (snapshot.seenDuplicateKeys.has(host.duplicateKey)) {
      snapshot.skippedDuplicateHostCount += 1
      continue
    }

    snapshot.seenDuplicateKeys.add(host.duplicateKey)
    snapshot.hostsByKey.set(host.key, host)
  }
}

export function buildXshellGroupPreviews(
  groupPaths: Iterable<string>,
  hosts: Iterable<Pick<XshellSnapshotHost, 'groupPath'>>
): XshellImportGroupPreview[] {
  const hostList = [...hosts]
  const normalizedPaths = [...new Set([...groupPaths].map((value) => normalizeGroupPath(value)).filter((value): value is string => Boolean(value)))]

  return normalizedPaths
    .map((groupPath) => {
      const parentPath = groupPath.includes('/') ? groupPath.split('/').slice(0, -1).join('/') : null
      const name = groupPath.split('/').at(-1) ?? groupPath
      const hostCount = hostList.filter((host) => {
        const candidatePath = normalizeGroupPath(host.groupPath)
        return candidatePath === groupPath || Boolean(candidatePath && candidatePath.startsWith(`${groupPath}/`))
      }).length

      return {
        path: groupPath,
        name,
        parentPath,
        hostCount
      }
    })
    .sort((left, right) => left.path.localeCompare(right.path))
}

function buildXshellHostPreviews(hosts: Iterable<XshellSnapshotHost>): XshellImportHostPreview[] {
  return [...hosts]
    .map((host) => ({
      key: host.key,
      label: host.label,
      hostname: host.hostname,
      port: host.port,
      username: host.username,
      authType: host.authType,
      groupPath: host.groupPath,
      privateKeyPath: host.privateKeyPath,
      sourceFilePath: host.sourceFilePath,
      hasPasswordHint: host.hasPasswordHint,
      hasAuthProfile: host.hasAuthProfile
    }))
    .sort((left, right) => {
      const groupCompare = (left.groupPath ?? '').localeCompare(right.groupPath ?? '')
      if (groupCompare !== 0) {
        return groupCompare
      }
      return left.label.localeCompare(right.label)
    })
}

function buildProbeResult(snapshotId: string, snapshot: XshellSnapshot): XshellProbeResult {
  return {
    snapshotId,
    sources: [...snapshot.sources],
    groups: buildXshellGroupPreviews(snapshot.groupPaths, snapshot.hostsByKey.values()),
    hosts: buildXshellHostPreviews(snapshot.hostsByKey.values()),
    warnings: [...snapshot.warnings],
    skippedExistingHostCount: snapshot.skippedExistingHostCount,
    skippedDuplicateHostCount: snapshot.skippedDuplicateHostCount
  }
}

export function collectSelectedXshellHosts(snapshot: XshellSnapshot, input: XshellImportSelectionInput): XshellSnapshotHost[] {
  const selectedHostKeys = new Set(input.selectedHostKeys)
  const selectedGroupPaths = new Set(
    input.selectedGroupPaths.map((value) => normalizeGroupPath(value)).filter((value): value is string => Boolean(value))
  )
  const resolved = new Map<string, XshellSnapshotHost>()

  for (const host of snapshot.hostsByKey.values()) {
    const matchedByGroup = [...selectedGroupPaths].some((groupPath) => {
      const hostGroupPath = normalizeGroupPath(host.groupPath)
      return hostGroupPath === groupPath || Boolean(hostGroupPath && hostGroupPath.startsWith(`${groupPath}/`))
    })
    if (!selectedHostKeys.has(host.key) && !matchedByGroup) {
      continue
    }
    resolved.set(host.key, host)
  }

  return [...resolved.values()].sort((left, right) => {
    const groupCompare = (left.groupPath ?? '').localeCompare(right.groupPath ?? '')
    if (groupCompare !== 0) {
      return groupCompare
    }
    return left.label.localeCompare(right.label)
  })
}

export function collectSelectedXshellGroupPaths(snapshot: XshellSnapshot, input: XshellImportSelectionInput): string[] {
  const explicitSelections = new Set(
    input.selectedGroupPaths.map((value) => normalizeGroupPath(value)).filter((value): value is string => Boolean(value))
  )

  for (const host of collectSelectedXshellHosts(snapshot, input)) {
    for (const candidatePath of buildXshellGroupAncestorPaths(host.groupPath)) {
      explicitSelections.add(candidatePath)
    }
  }

  return [...explicitSelections].sort((left, right) => {
    const depthCompare = left.split('/').length - right.split('/').length
    if (depthCompare !== 0) {
      return depthCompare
    }
    return left.localeCompare(right)
  })
}

export class XshellImportService {
  private readonly snapshots = new Map<string, XshellSnapshot>()

  constructor(private readonly resolveDocumentsDirectory: () => string) {}

  async findDefaultSessionDirectory(): Promise<string | null> {
    const baseDirectory = path.join(this.resolveDocumentsDirectory(), 'NetSarang Computer')

    try {
      const entries = await readdir(baseDirectory, { withFileTypes: true })
      const candidates: Array<{ version: string; folderPath: string }> = []

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue
        }

        const sessionDirectory = path.join(baseDirectory, entry.name, 'Xshell', 'Sessions')
        try {
          await access(sessionDirectory, fsConstants.F_OK)
          candidates.push({
            version: entry.name,
            folderPath: await realpath(sessionDirectory)
          })
        } catch {
          continue
        }
      }

      if (candidates.length === 0) {
        return null
      }

      candidates.sort((left, right) => compareVersionLabels(left.version, right.version))
      return candidates.at(-1)?.folderPath ?? null
    } catch {
      return null
    }
  }

  async getPickerDefaultPath(): Promise<string> {
    return (
      (await this.findDefaultSessionDirectory()) ??
      path.join(this.resolveDocumentsDirectory(), 'NetSarang Computer')
    )
  }

  private createSnapshot(): { snapshotId: string; snapshot: XshellSnapshot } {
    const snapshotId = randomUUID()
    const snapshot = createEmptySnapshot()
    this.snapshots.set(snapshotId, snapshot)
    return {
      snapshotId,
      snapshot
    }
  }

  async probeDefault(existingDuplicateKeys: ReadonlySet<string>): Promise<XshellProbeResult> {
    const { snapshotId, snapshot } = this.createSnapshot()
    const defaultSessionDirectory = await this.findDefaultSessionDirectory()

    if (!defaultSessionDirectory) {
      return buildProbeResult(snapshotId, snapshot)
    }

    const parsedSource = await buildParsedSource(defaultSessionDirectory, 'default-session-dir')
    mergeParsedSource(snapshot, parsedSource, existingDuplicateKeys)
    return buildProbeResult(snapshotId, snapshot)
  }

  async addFolderToSnapshot(
    input: XshellSnapshotFolderInput,
    existingDuplicateKeys: ReadonlySet<string>
  ): Promise<XshellProbeResult> {
    const snapshot = this.snapshots.get(input.snapshotId)
    if (!snapshot) {
      throw new Error('Xshell 가져오기 상태를 찾지 못했습니다. 대화상자를 다시 열어주세요.')
    }

    const parsedSource = await buildParsedSource(input.folderPath, 'manual-folder')
    mergeParsedSource(snapshot, parsedSource, existingDuplicateKeys)
    return buildProbeResult(input.snapshotId, snapshot)
  }

  getSnapshot(snapshotId: string): XshellSnapshot | null {
    return this.snapshots.get(snapshotId) ?? null
  }

  discardSnapshot(snapshotId: string): void {
    this.snapshots.delete(snapshotId)
  }
}

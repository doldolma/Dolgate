import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type AwsProfileIniSectionKind = "profile" | "sso-session" | "other";
type AwsProfileIniFileKind = "config" | "credentials";

interface AwsProfileIniSection {
  kind: AwsProfileIniSectionKind;
  logicalName: string;
  startLineIndex: number;
  endLineIndex: number;
}

interface AwsProfileIniDocument {
  filePath: string;
  exists: boolean;
  dirty: boolean;
  lineEnding: string;
  hasTrailingNewline: boolean;
  lines: string[];
}

export interface AwsProfileDocuments {
  rootDir: string;
  config: AwsProfileIniDocument;
  credentials: AwsProfileIniDocument;
}

export interface AwsProfileDocumentSnapshot {
  hasConfigSection: boolean;
  hasCredentialsSection: boolean;
  configValues: Record<string, string>;
  credentialValues: Record<string, string>;
  mergedValues: Record<string, string>;
  referencedByProfileNames: string[];
  sharedSsoSessionProfileNames: string[];
  orphanedSsoSessionName: string | null;
}

const DEFAULT_LINE_ENDING = "\n";

function toDocumentLines(raw: string): {
  lines: string[];
  lineEnding: string;
  hasTrailingNewline: boolean;
} {
  const lineEnding = raw.includes("\r\n") ? "\r\n" : DEFAULT_LINE_ENDING;
  const hasTrailingNewline =
    raw.endsWith("\r\n") || raw.endsWith("\n") || raw.endsWith("\r");
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const trimmed = hasTrailingNewline ? normalized.replace(/\n$/, "") : normalized;
  return {
    lines: trimmed.length > 0 ? trimmed.split("\n") : [],
    lineEnding,
    hasTrailingNewline,
  };
}

function serializeDocument(document: AwsProfileIniDocument): string {
  if (document.lines.length === 0) {
    return "";
  }
  const content = document.lines.join(document.lineEnding);
  return document.hasTrailingNewline ? `${content}${document.lineEnding}` : content;
}

async function loadIniDocument(filePath: string): Promise<AwsProfileIniDocument> {
  try {
    const raw = await readFile(filePath, "utf8");
    const { lines, lineEnding, hasTrailingNewline } = toDocumentLines(raw);
    return {
      filePath,
      exists: true,
      dirty: false,
      lineEnding,
      hasTrailingNewline,
      lines,
    };
  } catch (error) {
    const missing =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT";
    if (missing) {
      return {
        filePath,
        exists: false,
        dirty: false,
        lineEnding: DEFAULT_LINE_ENDING,
        hasTrailingNewline: false,
        lines: [],
      };
    }
    throw error;
  }
}

function parseSectionHeader(
  header: string,
  fileKind: AwsProfileIniFileKind,
): { kind: AwsProfileIniSectionKind; logicalName: string } {
  const trimmed = header.trim();
  if (fileKind === "config") {
    if (trimmed === "default") {
      return { kind: "profile", logicalName: "default" };
    }
    if (trimmed.startsWith("profile ")) {
      return {
        kind: "profile",
        logicalName: trimmed.slice("profile ".length).trim(),
      };
    }
    if (trimmed.startsWith("sso-session ")) {
      return {
        kind: "sso-session",
        logicalName: trimmed.slice("sso-session ".length).trim(),
      };
    }
    return { kind: "other", logicalName: trimmed };
  }

  return {
    kind: "profile",
    logicalName: trimmed,
  };
}

function listSections(
  document: AwsProfileIniDocument,
  fileKind: AwsProfileIniFileKind,
): AwsProfileIniSection[] {
  const headers: Array<{
    header: string;
    lineIndex: number;
  }> = [];

  for (let index = 0; index < document.lines.length; index += 1) {
    const match = document.lines[index]?.match(/^\s*\[([^\]]+)\]\s*$/);
    if (!match) {
      continue;
    }
    headers.push({
      header: match[1] ?? "",
      lineIndex: index,
    });
  }

  return headers.map((entry, index) => {
    const nextHeader = headers[index + 1];
    const parsed = parseSectionHeader(entry.header, fileKind);
    return {
      kind: parsed.kind,
      logicalName: parsed.logicalName,
      startLineIndex: entry.lineIndex,
      endLineIndex: nextHeader?.lineIndex ?? document.lines.length,
    };
  });
}

function findSection(
  document: AwsProfileIniDocument,
  fileKind: AwsProfileIniFileKind,
  sectionKind: AwsProfileIniSectionKind,
  logicalName: string,
): AwsProfileIniSection | null {
  return (
    listSections(document, fileKind).find(
      (section) =>
        section.kind === sectionKind && section.logicalName === logicalName,
    ) ?? null
  );
}

function parseKeyValueLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
    return null;
  }
  const separatorIndex = line.indexOf("=");
  if (separatorIndex <= 0) {
    return null;
  }
  const key = line.slice(0, separatorIndex).trim();
  if (!key) {
    return null;
  }
  return {
    key,
    value: line.slice(separatorIndex + 1).trim(),
  };
}

function getSectionValues(
  document: AwsProfileIniDocument,
  fileKind: AwsProfileIniFileKind,
  sectionKind: AwsProfileIniSectionKind,
  logicalName: string,
): Record<string, string> {
  const section = findSection(document, fileKind, sectionKind, logicalName);
  if (!section) {
    return {};
  }
  const values: Record<string, string> = {};
  for (
    let lineIndex = section.startLineIndex + 1;
    lineIndex < section.endLineIndex;
    lineIndex += 1
  ) {
    const parsed = parseKeyValueLine(document.lines[lineIndex] ?? "");
    if (!parsed) {
      continue;
    }
    values[parsed.key] = parsed.value;
  }
  return values;
}

function getProfileHeaderLine(
  fileKind: AwsProfileIniFileKind,
  profileName: string,
): string {
  if (fileKind === "config") {
    return profileName === "default"
      ? "[default]"
      : `[profile ${profileName}]`;
  }
  return `[${profileName}]`;
}

function getSectionHeaderLine(
  fileKind: AwsProfileIniFileKind,
  sectionKind: AwsProfileIniSectionKind,
  logicalName: string,
): string {
  if (sectionKind === "sso-session") {
    return `[sso-session ${logicalName}]`;
  }
  return getProfileHeaderLine(fileKind, logicalName);
}

function replaceSectionHeader(
  document: AwsProfileIniDocument,
  fileKind: AwsProfileIniFileKind,
  logicalName: string,
  nextLogicalName: string,
): void {
  const section = findSection(document, fileKind, "profile", logicalName);
  if (!section) {
    return;
  }
  document.lines[section.startLineIndex] = getProfileHeaderLine(
    fileKind,
    nextLogicalName,
  );
  document.dirty = true;
}

function normalizeAfterSectionRemoval(
  document: AwsProfileIniDocument,
  startLineIndex: number,
): void {
  while (
    startLineIndex > 0 &&
    startLineIndex < document.lines.length &&
    document.lines[startLineIndex - 1]?.trim() === "" &&
    document.lines[startLineIndex]?.trim() === ""
  ) {
    document.lines.splice(startLineIndex, 1);
  }
  while (document.lines[0]?.trim() === "") {
    document.lines.shift();
  }
}

function removeSection(
  document: AwsProfileIniDocument,
  fileKind: AwsProfileIniFileKind,
  sectionKind: AwsProfileIniSectionKind,
  logicalName: string,
): void {
  const section = findSection(document, fileKind, sectionKind, logicalName);
  if (!section) {
    return;
  }
  document.lines.splice(
    section.startLineIndex,
    section.endLineIndex - section.startLineIndex,
  );
  normalizeAfterSectionRemoval(document, section.startLineIndex);
  document.dirty = true;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceKeyValueLine(
  line: string,
  key: string,
  nextValue: string,
): string {
  const pattern = new RegExp(
    `^(\\s*${escapeRegExp(key)}\\s*=\\s*)(.*?)(\\s*(?:[#;].*)?)$`,
  );
  const match = line.match(pattern);
  if (!match) {
    return `${key} = ${nextValue}`;
  }
  return `${match[1] ?? ""}${nextValue}${match[3] ?? ""}`;
}

function replaceProfileKeyValue(
  document: AwsProfileIniDocument,
  fileKind: AwsProfileIniFileKind,
  profileName: string,
  key: string,
  nextValue: string,
): void {
  const section = findSection(document, fileKind, "profile", profileName);
  if (!section) {
    return;
  }
  for (
    let lineIndex = section.startLineIndex + 1;
    lineIndex < section.endLineIndex;
    lineIndex += 1
  ) {
    const parsed = parseKeyValueLine(document.lines[lineIndex] ?? "");
    if (!parsed || parsed.key !== key) {
      continue;
    }
    document.lines[lineIndex] = replaceKeyValueLine(
      document.lines[lineIndex] ?? "",
      key,
      nextValue,
    );
    document.dirty = true;
    return;
  }
  document.lines.splice(section.endLineIndex, 0, `${key} = ${nextValue}`);
  document.dirty = true;
}

function upsertSectionKeyValue(
  document: AwsProfileIniDocument,
  fileKind: AwsProfileIniFileKind,
  sectionKind: AwsProfileIniSectionKind,
  logicalName: string,
  key: string,
  nextValue: string,
): void {
  const section = findSection(document, fileKind, sectionKind, logicalName);
  if (!section) {
    if (document.lines.length > 0 && document.lines[document.lines.length - 1]?.trim() !== "") {
      document.lines.push("");
    }
    document.lines.push(getSectionHeaderLine(fileKind, sectionKind, logicalName));
    document.lines.push(`${key} = ${nextValue}`);
    document.dirty = true;
    if (!document.exists) {
      document.hasTrailingNewline = true;
    }
    return;
  }

  for (
    let lineIndex = section.startLineIndex + 1;
    lineIndex < section.endLineIndex;
    lineIndex += 1
  ) {
    const parsed = parseKeyValueLine(document.lines[lineIndex] ?? "");
    if (!parsed || parsed.key !== key) {
      continue;
    }
    document.lines[lineIndex] = replaceKeyValueLine(
      document.lines[lineIndex] ?? "",
      key,
      nextValue,
    );
    document.dirty = true;
    return;
  }

  document.lines.splice(section.endLineIndex, 0, `${key} = ${nextValue}`);
  document.dirty = true;
}

function removeProfileKey(
  document: AwsProfileIniDocument,
  fileKind: AwsProfileIniFileKind,
  profileName: string,
  key: string,
): void {
  const section = findSection(document, fileKind, "profile", profileName);
  if (!section) {
    return;
  }
  for (
    let lineIndex = section.startLineIndex + 1;
    lineIndex < section.endLineIndex;
    lineIndex += 1
  ) {
    const parsed = parseKeyValueLine(document.lines[lineIndex] ?? "");
    if (!parsed || parsed.key !== key) {
      continue;
    }
    document.lines.splice(lineIndex, 1);
    document.dirty = true;
    return;
  }
}

function replaceSourceProfileReferences(
  document: AwsProfileIniDocument,
  oldProfileName: string,
  nextProfileName: string,
): void {
  const sections = listSections(document, "config").filter(
    (section) => section.kind === "profile",
  );
  for (const section of sections) {
    for (
      let lineIndex = section.startLineIndex + 1;
      lineIndex < section.endLineIndex;
      lineIndex += 1
    ) {
      const parsed = parseKeyValueLine(document.lines[lineIndex] ?? "");
      if (!parsed || parsed.key !== "source_profile") {
        continue;
      }
      if (parsed.value.trim() !== oldProfileName) {
        continue;
      }
      document.lines[lineIndex] = replaceKeyValueLine(
        document.lines[lineIndex] ?? "",
        "source_profile",
        nextProfileName,
      );
      document.dirty = true;
    }
  }
}

function findProfileReferencesByKeyValue(
  document: AwsProfileIniDocument,
  key: string,
  value: string,
): string[] {
  const matches = new Set<string>();
  for (const section of listSections(document, "config")) {
    if (section.kind !== "profile") {
      continue;
    }
    for (
      let lineIndex = section.startLineIndex + 1;
      lineIndex < section.endLineIndex;
      lineIndex += 1
    ) {
      const parsed = parseKeyValueLine(document.lines[lineIndex] ?? "");
      if (!parsed || parsed.key !== key) {
        continue;
      }
      if (parsed.value.trim() === value) {
        matches.add(section.logicalName);
      }
    }
  }
  return [...matches].sort((left, right) => left.localeCompare(right));
}

export function getDefaultAwsProfileRootDir(): string {
  return path.join(os.homedir(), ".aws");
}

export async function loadAwsProfileDocuments(
  rootDir = getDefaultAwsProfileRootDir(),
): Promise<AwsProfileDocuments> {
  const [config, credentials] = await Promise.all([
    loadIniDocument(path.join(rootDir, "config")),
    loadIniDocument(path.join(rootDir, "credentials")),
  ]);
  return {
    rootDir,
    config,
    credentials,
  };
}

export function inspectAwsProfileDocuments(
  documents: AwsProfileDocuments,
  profileName: string,
): AwsProfileDocumentSnapshot {
  const configSection = findSection(
    documents.config,
    "config",
    "profile",
    profileName,
  );
  const credentialsSection = findSection(
    documents.credentials,
    "credentials",
    "profile",
    profileName,
  );
  const configValues = getSectionValues(
    documents.config,
    "config",
    "profile",
    profileName,
  );
  const credentialValues = getSectionValues(
    documents.credentials,
    "credentials",
    "profile",
    profileName,
  );
  const mergedValues = {
    ...configValues,
    ...credentialValues,
  };
  const referencedByProfileNames = findProfileReferencesByKeyValue(
    documents.config,
    "source_profile",
    profileName,
  ).filter((name) => name !== profileName);
  const ssoSessionName = mergedValues.sso_session?.trim() || null;
  const sharedSsoSessionProfileNames = ssoSessionName
    ? findProfileReferencesByKeyValue(
        documents.config,
        "sso_session",
        ssoSessionName,
      ).filter((name) => name !== profileName)
    : [];

  return {
    hasConfigSection: Boolean(configSection),
    hasCredentialsSection: Boolean(credentialsSection),
    configValues,
    credentialValues,
    mergedValues,
    referencedByProfileNames,
    sharedSsoSessionProfileNames,
    orphanedSsoSessionName:
      ssoSessionName && sharedSsoSessionProfileNames.length === 0
        ? ssoSessionName
        : null,
  };
}

export function renameAwsProfileInDocuments(
  documents: AwsProfileDocuments,
  profileName: string,
  nextProfileName: string,
): void {
  replaceSectionHeader(documents.config, "config", profileName, nextProfileName);
  replaceSectionHeader(
    documents.credentials,
    "credentials",
    profileName,
    nextProfileName,
  );
  replaceSourceProfileReferences(
    documents.config,
    profileName,
    nextProfileName,
  );
}

export function removeAwsProfileKeyFromDocuments(
  documents: AwsProfileDocuments,
  profileName: string,
  key: string,
): void {
  removeProfileKey(documents.config, "config", profileName, key);
  removeProfileKey(documents.credentials, "credentials", profileName, key);
}

export function setAwsProfileKeyValueInDocuments(
  documents: AwsProfileDocuments,
  fileKind: AwsProfileIniFileKind,
  profileName: string,
  key: string,
  value: string,
): void {
  const document = fileKind === "config" ? documents.config : documents.credentials;
  upsertSectionKeyValue(document, fileKind, "profile", profileName, key, value);
}

export function setAwsSsoSessionKeyValueInDocuments(
  documents: AwsProfileDocuments,
  sessionName: string,
  key: string,
  value: string,
): void {
  upsertSectionKeyValue(
    documents.config,
    "config",
    "sso-session",
    sessionName,
    key,
    value,
  );
}

export function getAwsSsoSessionValues(
  documents: AwsProfileDocuments,
  sessionName: string,
): Record<string, string> {
  return getSectionValues(
    documents.config,
    "config",
    "sso-session",
    sessionName,
  );
}

export function deleteAwsProfileFromDocuments(
  documents: AwsProfileDocuments,
  profileName: string,
): void {
  const snapshot = inspectAwsProfileDocuments(documents, profileName);
  removeSection(documents.config, "config", "profile", profileName);
  removeSection(documents.credentials, "credentials", "profile", profileName);
  if (snapshot.orphanedSsoSessionName) {
    removeSection(
      documents.config,
      "config",
      "sso-session",
      snapshot.orphanedSsoSessionName,
    );
  }
}

export async function writeAwsProfileDocuments(
  documents: AwsProfileDocuments,
): Promise<void> {
  const writes = [documents.config, documents.credentials]
    .filter((document) => document.dirty)
    .map(async (document) => {
      await mkdir(path.dirname(document.filePath), { recursive: true });
      await writeFile(document.filePath, serializeDocument(document), "utf8");
      document.exists = true;
      document.dirty = false;
    });
  await Promise.all(writes);
}

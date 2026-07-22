import {
  createVaultKdfDescriptor,
  deriveVaultKek,
  isSupportedVaultKdfDescriptor,
  type DnsOverrideRecord,
  type GroupRecord,
  type HostRecord,
  type KnownHostRecord,
  type ManagedAwsProfilePayload,
  type ManagedSecretPayload,
  type PortForwardRuleRecord,
  type SnippetRecord,
  type VaultKdfDescriptor,
} from "@shared";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { desktopArgon2idDerive } from "./vault-crypto";

const MAGIC = Buffer.from("DOLGATE\0", "ascii");
const CONTAINER_VERSION = 1;
const PREFIX_LENGTH = MAGIC.length + 2 + 4;
const TAG_LENGTH = 16;
const NONCE_LENGTH = 12;
const MAX_HEADER_BYTES = 16 * 1024;
export const MAX_DOLGATE_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_DOLGATE_RECORDS = 100_000;

export interface DolgateHostBundleV1 {
  schemaVersion: 1;
  scope: "hosts";
  exportedAt: string;
  rootHostIds: string[];
  groups: GroupRecord[];
  hosts: HostRecord[];
  secrets: ManagedSecretPayload[];
  knownHosts: KnownHostRecord[];
  portForwards: PortForwardRuleRecord[];
  dnsOverrides: DnsOverrideRecord[];
  awsProfiles: ManagedAwsProfilePayload[];
  snippets: SnippetRecord[];
}

interface DolgateFileHeaderV1 {
  type: "dolgate-host-bundle";
  createdAt: string;
  appVersion: string;
  kdf: VaultKdfDescriptor;
  cipher: {
    algorithm: "aes-256-gcm";
    nonceBase64: string;
    tagLength: 16;
  };
}

function assertExportPassword(password: string): void {
  const normalized = password.normalize("NFC");
  if (normalized.trim().length === 0) {
    throw new Error("내보내기 암호를 입력해 주세요.");
  }
  if (Array.from(normalized).length < 4) {
    throw new Error("내보내기 암호는 4자 이상이어야 합니다.");
  }
  if (normalized.length > 1024) {
    throw new Error("내보내기 암호가 너무 깁니다.");
  }
}

function parseHeader(value: unknown): DolgateFileHeaderV1 {
  if (!value || typeof value !== "object") {
    throw new Error("올바른 Dolgate 내보내기 파일이 아닙니다.");
  }
  const header = value as Partial<DolgateFileHeaderV1>;
  if (
    header.type !== "dolgate-host-bundle" ||
    typeof header.createdAt !== "string" ||
    typeof header.appVersion !== "string" ||
    !header.kdf ||
    !isSupportedVaultKdfDescriptor(header.kdf) ||
    header.cipher?.algorithm !== "aes-256-gcm" ||
    typeof header.cipher.nonceBase64 !== "string" ||
    header.cipher.tagLength !== TAG_LENGTH
  ) {
    throw new Error("지원하지 않거나 손상된 Dolgate 내보내기 파일입니다.");
  }
  const nonce = Buffer.from(header.cipher.nonceBase64, "base64");
  if (nonce.length !== NONCE_LENGTH) {
    throw new Error("지원하지 않거나 손상된 Dolgate 내보내기 파일입니다.");
  }
  return header as DolgateFileHeaderV1;
}

export async function encryptDolgateHostBundle(
  bundle: DolgateHostBundleV1,
  password: string,
  appVersion: string,
): Promise<Buffer> {
  assertExportPassword(password);
  const kdf = createVaultKdfDescriptor();
  const nonce = randomBytes(NONCE_LENGTH);
  const header: DolgateFileHeaderV1 = {
    type: "dolgate-host-bundle",
    createdAt: new Date().toISOString(),
    appVersion,
    kdf,
    cipher: {
      algorithm: "aes-256-gcm",
      nonceBase64: nonce.toString("base64"),
      tagLength: TAG_LENGTH,
    },
  };
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  if (headerBytes.length > MAX_HEADER_BYTES) {
    throw new Error("Dolgate 내보내기 헤더가 너무 큽니다.");
  }
  const plaintext = Buffer.from(JSON.stringify(bundle), "utf8");
  if (plaintext.length > MAX_DOLGATE_FILE_BYTES) {
    throw new Error("선택한 항목이 너무 커서 하나의 파일로 내보낼 수 없습니다.");
  }

  const key = Buffer.from(await deriveVaultKek(desktopArgon2idDerive, password, kdf));
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce, {
      authTagLength: TAG_LENGTH,
    });
    cipher.setAAD(headerBytes);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const prefix = Buffer.alloc(PREFIX_LENGTH);
    MAGIC.copy(prefix, 0);
    prefix.writeUInt16BE(CONTAINER_VERSION, MAGIC.length);
    prefix.writeUInt32BE(headerBytes.length, MAGIC.length + 2);
    const file = Buffer.concat([prefix, headerBytes, ciphertext, tag]);
    if (file.length > MAX_DOLGATE_FILE_BYTES) {
      throw new Error("선택한 항목이 너무 커서 하나의 파일로 내보낼 수 없습니다.");
    }
    return file;
  } finally {
    key.fill(0);
    plaintext.fill(0);
  }
}

export async function decryptDolgateHostBundle(
  file: Buffer,
  password: string,
): Promise<unknown> {
  if (file.length > MAX_DOLGATE_FILE_BYTES || file.length < PREFIX_LENGTH + TAG_LENGTH) {
    throw new Error("올바른 Dolgate 내보내기 파일이 아닙니다.");
  }
  if (!file.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("올바른 Dolgate 내보내기 파일이 아닙니다.");
  }
  if (file.readUInt16BE(MAGIC.length) !== CONTAINER_VERSION) {
    throw new Error("이 버전의 앱에서 지원하지 않는 Dolgate 파일입니다.");
  }
  const headerLength = file.readUInt32BE(MAGIC.length + 2);
  const ciphertextOffset = PREFIX_LENGTH + headerLength;
  if (
    headerLength <= 0 ||
    headerLength > MAX_HEADER_BYTES ||
    ciphertextOffset + TAG_LENGTH >= file.length
  ) {
    throw new Error("지원하지 않거나 손상된 Dolgate 내보내기 파일입니다.");
  }

  const headerBytes = file.subarray(PREFIX_LENGTH, ciphertextOffset);
  let headerValue: unknown;
  try {
    headerValue = JSON.parse(headerBytes.toString("utf8"));
  } catch {
    throw new Error("지원하지 않거나 손상된 Dolgate 내보내기 파일입니다.");
  }
  const header = parseHeader(headerValue);
  const nonce = Buffer.from(header.cipher.nonceBase64, "base64");
  const ciphertext = file.subarray(ciphertextOffset, file.length - TAG_LENGTH);
  const tag = file.subarray(file.length - TAG_LENGTH);
  let key: Buffer | null = null;
  let plaintext: Buffer | null = null;
  try {
    key = Buffer.from(
      await deriveVaultKek(desktopArgon2idDerive, password, header.kdf),
    );
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
      authTagLength: TAG_LENGTH,
    });
    decipher.setAAD(headerBytes);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8")) as unknown;
  } catch {
    throw new Error("암호가 올바르지 않거나 파일이 손상되었습니다.");
  } finally {
    key?.fill(0);
    plaintext?.fill(0);
  }
}

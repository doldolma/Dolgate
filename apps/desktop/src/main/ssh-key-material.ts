import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { t } from './i18n';

export type SshKeyAlgorithm = "ed25519" | "ecdsa" | "rsa";
export type SshKeyCurve = "nistp256" | "nistp384" | "nistp521";
export type SshRsaBits = 3072 | 4096;

export interface CreateSshKeyPairOptions {
  algorithm?: SshKeyAlgorithm;
  curve?: SshKeyCurve;
  rsaBits?: SshRsaBits;
  comment?: string | null;
}

export interface SshKeyPairMaterial {
  algorithm: string;
  privateKeyPem: string;
  publicKey: string;
  fingerprintSha256: string;
  privateKeyEncrypted: boolean;
  keyCurve?: SshKeyCurve;
  keyBits?: SshRsaBits;
}

const ECDSA_CURVE_TO_NODE = {
  nistp256: "prime256v1",
  nistp384: "secp384r1",
  nistp521: "secp521r1",
} as const;

function base64UrlToBuffer(value: string): Buffer {
  const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function encodeSshWireValue(value: string | Buffer): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

function encodeMpint(value: Buffer): Buffer {
  const firstNonZero = value.findIndex((byte) => byte !== 0);
  const normalized = firstNonZero >= 0 ? value.subarray(firstNonZero) : Buffer.alloc(0);
  const positive =
    normalized.length > 0 && (normalized[0] & 0x80) !== 0
      ? Buffer.concat([Buffer.from([0]), normalized])
      : normalized;
  return encodeSshWireValue(positive);
}

function withComment(publicKey: string, comment?: string | null): string {
  const normalizedComment = comment?.trim();
  return normalizedComment ? `${publicKey} ${normalizedComment}` : publicKey;
}

export function fingerprintSha256FromPublicKey(publicKey: string): string {
  const [, publicKeyBase64] = publicKey.trim().split(/\s+/, 3);
  if (!publicKeyBase64) {
    throw new Error(t('sshKeyMaterial.parseFailed'));
  }
  const digest = createHash("sha256")
    .update(Buffer.from(publicKeyBase64, "base64"))
    .digest("base64")
    .replace(/=+$/g, "");
  return `SHA256:${digest}`;
}

export function formatEd25519PublicKey(
  publicKey: KeyObject,
  comment?: string | null,
): string {
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
  const x = typeof jwk.x === "string" ? jwk.x : "";
  if (!x) {
    throw new Error(t('sshKeyMaterial.generateFailed'));
  }
  const encodedPublicKey = Buffer.concat([
    encodeSshWireValue("ssh-ed25519"),
    encodeSshWireValue(base64UrlToBuffer(x)),
  ]).toString("base64");
  return withComment(`ssh-ed25519 ${encodedPublicKey}`, comment);
}

function formatEcdsaPublicKey(
  publicKey: KeyObject,
  curve: SshKeyCurve,
  comment?: string | null,
): string {
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string; y?: string };
  const x = typeof jwk.x === "string" ? base64UrlToBuffer(jwk.x) : null;
  const y = typeof jwk.y === "string" ? base64UrlToBuffer(jwk.y) : null;
  if (!x || !y) {
    throw new Error(t('sshKeyMaterial.generateFailed'));
  }
  const algorithm = `ecdsa-sha2-${curve}`;
  const q = Buffer.concat([Buffer.from([0x04]), x, y]);
  const encodedPublicKey = Buffer.concat([
    encodeSshWireValue(algorithm),
    encodeSshWireValue(curve),
    encodeSshWireValue(q),
  ]).toString("base64");
  return withComment(`${algorithm} ${encodedPublicKey}`, comment);
}

function formatRsaPublicKey(
  publicKey: KeyObject,
  comment?: string | null,
): string {
  const jwk = publicKey.export({ format: "jwk" }) as { e?: string; n?: string };
  const e = typeof jwk.e === "string" ? base64UrlToBuffer(jwk.e) : null;
  const n = typeof jwk.n === "string" ? base64UrlToBuffer(jwk.n) : null;
  if (!e || !n) {
    throw new Error(t('sshKeyMaterial.generateFailed'));
  }
  const encodedPublicKey = Buffer.concat([
    encodeSshWireValue("ssh-rsa"),
    encodeMpint(e),
    encodeMpint(n),
  ]).toString("base64");
  return withComment(`ssh-rsa ${encodedPublicKey}`, comment);
}

function exportPkcs8PrivateKey(privateKey: KeyObject): string {
  return privateKey.export({ format: "pem", type: "pkcs8" }) as string;
}

export function createSshKeyPair(
  options: CreateSshKeyPairOptions = {},
): SshKeyPairMaterial {
  const algorithm = options.algorithm ?? "ed25519";

  if (algorithm === "ecdsa") {
    const curve =
      options.curve === "nistp256" || options.curve === "nistp384"
        ? options.curve
        : "nistp521";
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: ECDSA_CURVE_TO_NODE[curve],
    });
    const authorizedKey = formatEcdsaPublicKey(publicKey, curve, options.comment);
    return {
      algorithm: `ecdsa-sha2-${curve}`,
      privateKeyPem: exportPkcs8PrivateKey(privateKey),
      publicKey: authorizedKey,
      fingerprintSha256: fingerprintSha256FromPublicKey(authorizedKey),
      privateKeyEncrypted: false,
      keyCurve: curve,
    };
  }

  if (algorithm === "rsa") {
    const keyBits = options.rsaBits === 3072 ? 3072 : 4096;
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: keyBits,
      publicExponent: 0x10001,
    });
    const authorizedKey = formatRsaPublicKey(publicKey, options.comment);
    return {
      algorithm: "ssh-rsa",
      privateKeyPem: exportPkcs8PrivateKey(privateKey),
      publicKey: authorizedKey,
      fingerprintSha256: fingerprintSha256FromPublicKey(authorizedKey),
      privateKeyEncrypted: false,
      keyBits,
    };
  }

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const authorizedKey = formatEd25519PublicKey(publicKey, options.comment);
  return {
    algorithm: "ssh-ed25519",
    privateKeyPem: exportPkcs8PrivateKey(privateKey),
    publicKey: authorizedKey,
    fingerprintSha256: fingerprintSha256FromPublicKey(authorizedKey),
    privateKeyEncrypted: false,
  };
}

export function createEd25519SshKeyPair(comment?: string | null): {
  algorithm: string;
  privateKeyPem: string;
  publicKey: string;
  fingerprintSha256: string;
} {
  const keyPair = createSshKeyPair({ algorithm: "ed25519", comment });
  return {
    algorithm: keyPair.algorithm,
    privateKeyPem: keyPair.privateKeyPem,
    publicKey: keyPair.publicKey,
    fingerprintSha256: keyPair.fingerprintSha256,
  };
}

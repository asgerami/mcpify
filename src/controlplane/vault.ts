import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

/**
 * AES-256-GCM credential vault — encrypts secrets at rest so persisted
 * credentials never touch disk in plaintext (the spec's security model:
 * "AES-256 at rest, decrypted only at proxy request time"). The master key is
 * supplied by the operator; values are decrypted only in memory when building a
 * server's credential store.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // GCM standard nonce length
const TAG_BYTES = 16;
const PREFIX = "v1"; // versioned envelope, in case the scheme changes

export class Vault {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) {
      throw new Error(`Vault key must be 32 bytes (got ${key.length}).`);
    }
    this.key = key;
  }

  /**
   * Build a vault from an operator-supplied secret. Accepts a 64-char hex or
   * base64 32-byte key directly; otherwise treats the input as a passphrase and
   * derives a key with scrypt. Returns undefined when no secret is configured.
   */
  static fromSecret(secret: string | undefined): Vault | undefined {
    if (!secret) return undefined;
    return new Vault(deriveKey(secret));
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): Vault | undefined {
    return Vault.fromSecret(env.WRANGL_SECRET_KEY);
  }

  /** Encrypt a plaintext value into a self-describing envelope string. */
  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}:${Buffer.concat([iv, tag, ciphertext]).toString("base64")}`;
  }

  /** Decrypt an envelope produced by {@link encrypt}; throws if tampered. */
  decrypt(envelope: string): string {
    const [prefix, payload] = splitOnce(envelope, ":");
    if (prefix !== PREFIX || !payload) {
      throw new Error("Unrecognized credential envelope.");
    }
    const raw = Buffer.from(payload, "base64");
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);

    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }
}

/** Resolve a 32-byte key from a hex/base64 key string or a passphrase. */
function deriveKey(secret: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(secret)) return Buffer.from(secret, "hex");
  if (/^[A-Za-z0-9+/]{43}=?$/.test(secret)) {
    const buf = Buffer.from(secret, "base64");
    if (buf.length === 32) return buf;
  }
  // Treat as a passphrase. Fixed salt keeps the derived key stable across
  // restarts (so envelopes remain decryptable); the passphrase is the secret.
  return scryptSync(secret, "wrangl.vault.v1", 32);
}

function splitOnce(value: string, sep: string): [string, string] {
  const i = value.indexOf(sep);
  return i === -1 ? [value, ""] : [value.slice(0, i), value.slice(i + 1)];
}

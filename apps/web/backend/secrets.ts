import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Encrypts webhook signing secrets stored in the database (AES-256-GCM). The key comes from NEEDL_SECRET_KEY
 * (32 bytes, base64). Outside production, a key is generated once into .needl/secret.key so
 * development works without setup; production refuses to start without an explicit key.
 *
 * To rotate the key, set NEEDL_SECRET_KEY_NEXT alongside the current key: new secrets are sealed with the next key,
 * either key opens a stored secret, and `resealSecrets` moves every stored secret to the next key. Once that has
 * run, the next key can replace NEEDL_SECRET_KEY everywhere.
 */
export class SecretBox {
  readonly #key: Buffer;
  readonly #previous: readonly Buffer[];

  constructor(key: Buffer, previous: readonly Buffer[] = []) {
    for (const candidate of [key, ...previous]) {
      if (candidate.length !== 32) throw new Error("NEEDL_SECRET_KEY must be 32 bytes, base64-encoded");
    }
    this.#key = key;
    this.#previous = previous;
  }

  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env): SecretBox {
    const configured = environment.NEEDL_SECRET_KEY;
    const next = environment.NEEDL_SECRET_KEY_NEXT?.trim();
    if (configured !== undefined && configured.length > 0) {
      const current = Buffer.from(configured, "base64");
      return next ? new SecretBox(Buffer.from(next, "base64"), [current]) : new SecretBox(current);
    }
    if (environment.NODE_ENV === "production") throw new Error("NEEDL_SECRET_KEY is required in production to store webhook secrets");
    const path = resolve(environment.NEEDL_SECRET_KEY_PATH ?? ".needl/secret.key");
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, randomBytes(32).toString("base64"), { mode: 0o600 });
    }
    return new SecretBox(Buffer.from(readFileSync(path, "utf8").trim(), "base64"));
  }

  /** True while a key rotation is in progress, so stored secrets may still be sealed with the previous key. */
  get rotating(): boolean {
    return this.#previous.length > 0;
  }

  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(":");
  }

  open(sealed: string): string {
    let failure: unknown;
    for (const key of [this.#key, ...this.#previous]) {
      try {
        return openWith(key, sealed);
      } catch (error) {
        failure = error;
      }
    }
    throw failure;
  }

  /** Whether a stored secret is already sealed with the current key. */
  isCurrent(sealed: string): boolean {
    try {
      openWith(this.#key, sealed);
      return true;
    } catch {
      return false;
    }
  }
}

function openWith(key: Buffer, sealed: string): string {
  const [version, iv, tag, ciphertext] = sealed.split(":");
  if (version !== "v1" || iv === undefined || tag === undefined || ciphertext === undefined) throw new Error("Stored secret has an unknown format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
}

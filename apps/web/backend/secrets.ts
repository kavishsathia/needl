import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Encrypts webhook signing secrets stored in the database (AES-256-GCM). The key comes from NEEDL_SECRET_KEY
 * (32 bytes, base64). Outside production, a key is generated once into a local file next to the SQLite database so
 * development works without setup; production refuses to start without an explicit key.
 */
export class SecretBox {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error("NEEDL_SECRET_KEY must be 32 bytes, base64-encoded");
    this.#key = key;
  }

  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env): SecretBox {
    const configured = environment.NEEDL_SECRET_KEY;
    if (configured !== undefined && configured.length > 0) return new SecretBox(Buffer.from(configured, "base64"));
    if (environment.NODE_ENV === "production") throw new Error("NEEDL_SECRET_KEY is required in production to store webhook secrets");
    const path = resolve(environment.NEEDL_SECRET_KEY_PATH ?? ".needl/secret.key");
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, randomBytes(32).toString("base64"), { mode: 0o600 });
    }
    return new SecretBox(Buffer.from(readFileSync(path, "utf8").trim(), "base64"));
  }

  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(":");
  }

  open(sealed: string): string {
    const [version, iv, tag, ciphertext] = sealed.split(":");
    if (version !== "v1" || iv === undefined || tag === undefined || ciphertext === undefined) throw new Error("Stored secret has an unknown format");
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
  }
}

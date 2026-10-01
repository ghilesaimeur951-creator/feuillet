import { concatBytes, randomBytes, textDecoder, textEncoder, toArrayBuffer } from '../util/bytes';

/**
 * Password-based encryption for locked documents (WebCrypto only, no dependency).
 *
 * - Key derivation: PBKDF2-HMAC-SHA-256, random 16-byte salt per document, 600 000 iterations
 *   (OWASP 2023 recommendation).
 * - Encryption: AES-256-GCM, fresh random 96-bit IV for every encrypted item, authenticated with
 *   the document id as additional data (a sealed blob cannot be moved to another document).
 * - Sealed format: "FLV1" | IV (12 bytes) | ciphertext + GCM tag.
 *
 * A wrong password is detected by the GCM authentication tag (no separate verifier is stored).
 */

export const VAULT_ITERATIONS = 600_000;
const MAGIC = textEncoder.encode('FLV1');
const IV_BYTES = 12;

export class WrongPasswordError extends Error {
  constructor() {
    super('Mot de passe incorrect');
    this.name = 'WrongPasswordError';
  }
}

export interface VaultKey {
  key: CryptoKey;
  salt: Uint8Array;
  iterations: number;
}

export const MIN_VAULT_PASSWORD = 6;

export function checkVaultPassword(password: string): string | null {
  if (password.length < MIN_VAULT_PASSWORD) return `Le mot de passe doit contenir au moins ${MIN_VAULT_PASSWORD} caractères`;
  return null;
}

export async function deriveVaultKey(password: string, salt: Uint8Array = randomBytes(16), iterations = VAULT_ITERATIONS): Promise<VaultKey> {
  if (!password) throw new Error('Mot de passe vide');
  const base = await crypto.subtle.importKey('raw', toArrayBuffer(textEncoder.encode(password.normalize('NFC'))), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: toArrayBuffer(salt), iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return { key, salt, iterations };
}

export async function seal(key: CryptoKey, data: Uint8Array, aad: string): Promise<Uint8Array> {
  const iv = randomBytes(IV_BYTES);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(textEncoder.encode(aad)) },
      key,
      toArrayBuffer(data),
    ),
  );
  return concatBytes([MAGIC, iv, ct]);
}

export function isSealed(data: Uint8Array): boolean {
  return data.length > MAGIC.length + IV_BYTES && MAGIC.every((b, i) => data[i] === b);
}

/** Decrypts a sealed item; throws `WrongPasswordError` when the key (password) or the AAD is wrong. */
export async function unseal(key: CryptoKey, sealed: Uint8Array, aad: string): Promise<Uint8Array> {
  if (!isSealed(sealed)) throw new Error('Données chiffrées invalides');
  const iv = sealed.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
  const ct = sealed.subarray(MAGIC.length + IV_BYTES);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(textEncoder.encode(aad)) },
        key,
        toArrayBuffer(ct),
      ),
    );
  } catch {
    throw new WrongPasswordError();
  }
}

export async function sealJson(key: CryptoKey, value: unknown, aad: string): Promise<string> {
  return toBase64(await seal(key, textEncoder.encode(JSON.stringify(value)), aad));
}

export async function unsealJson<T>(key: CryptoKey, sealed: string, aad: string): Promise<T> {
  return JSON.parse(textDecoder.decode(await unseal(key, fromBase64(sealed), aad))) as T;
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

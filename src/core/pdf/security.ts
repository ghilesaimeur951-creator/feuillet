import { concatBytes, randomBytes, textEncoder, toArrayBuffer } from '../util/bytes';

/**
 * PDF Standard Security Handler, revision 6 (AES-256, ISO 32000-2 §7.6.4).
 * Uses WebCrypto only. AES-CBC without padding is obtained by dropping the final padding block,
 * which is valid because CBC ciphertext of a prefix does not depend on later blocks.
 */

async function sha(alg: 'SHA-256' | 'SHA-384' | 'SHA-512', data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(alg, toArrayBuffer(data)));
}

async function aesCbcRaw(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  if (data.length % 16 !== 0) throw new Error('aesCbcRaw: longueur non multiple de 16');
  const k = await crypto.subtle.importKey('raw', toArrayBuffer(key), { name: 'AES-CBC' }, false, ['encrypt']);
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: toArrayBuffer(iv) }, k, toArrayBuffer(data)));
  return out.subarray(0, data.length);
}

/** AES-CBC with PKCS#7 padding and a random IV prepended (format used for PDF strings/streams). */
export async function aesEncryptWithIv(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const iv = randomBytes(16);
  const k = await crypto.subtle.importKey('raw', toArrayBuffer(key), { name: 'AES-CBC' }, false, ['encrypt']);
  const enc = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: toArrayBuffer(iv) }, k, toArrayBuffer(data)));
  return concatBytes([iv, enc]);
}

/** Algorithm 2.B — the iterated hash of revision 6. */
export async function hash2B(password: Uint8Array, salt: Uint8Array, udata: Uint8Array): Promise<Uint8Array> {
  let K = await sha('SHA-256', concatBytes([password, salt, udata]));
  let i = 0;
  for (;;) {
    const unit = concatBytes([password, K, udata]);
    const K1 = new Uint8Array(unit.length * 64);
    for (let r = 0; r < 64; r++) K1.set(unit, r * unit.length);
    const E = await aesCbcRaw(K.subarray(0, 16), K.subarray(16, 32), K1);
    let mod = 0;
    for (let b = 0; b < 16; b++) mod += E[b] as number;
    mod %= 3;
    K = await sha(mod === 0 ? 'SHA-256' : mod === 1 ? 'SHA-384' : 'SHA-512', E);
    i++;
    if (i >= 64 && (E[E.length - 1] as number) <= i - 32) break;
  }
  return K.subarray(0, 32);
}

function preparePassword(pw: string): Uint8Array {
  // SASLprep normalisation approximated with NFKC; truncated to 127 bytes as required.
  return textEncoder.encode(pw.normalize('NFKC')).subarray(0, 127);
}

export interface EncryptionSetup {
  fileKey: Uint8Array;
  /** Encryption dictionary body (without object wrapper). */
  dictionary: string;
}

function permissionsValue(): number {
  // Bits (1-based): 3 print, 4 modify, 5 copy, 6 annotate, 9 fill forms, 10 extract, 11 assemble, 12 print HQ.
  let p = 0xfffff000; // bits 13-32 set
  p |= 0b1100_0000; // bits 7-8 must be 1
  for (const bit of [3, 4, 5, 6, 9, 10, 11, 12]) p |= 1 << (bit - 1);
  return p | 0; // signed 32-bit
}

function hexStr(b: Uint8Array): string {
  let s = '<';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return `${s}>`;
}

export async function setupAes256(userPassword: string, ownerPassword?: string): Promise<EncryptionSetup> {
  const fileKey = randomBytes(32);
  const user = preparePassword(userPassword);
  const owner = preparePassword(ownerPassword && ownerPassword.length > 0 ? ownerPassword : userPassword);
  const uvs = randomBytes(8);
  const uks = randomBytes(8);
  const U = concatBytes([await hash2B(user, uvs, new Uint8Array(0)), uvs, uks]);
  const UE = await aesCbcRaw(await hash2B(user, uks, new Uint8Array(0)), new Uint8Array(16), fileKey);
  const ovs = randomBytes(8);
  const oks = randomBytes(8);
  const O = concatBytes([await hash2B(owner, ovs, U), ovs, oks]);
  const OE = await aesCbcRaw(await hash2B(owner, oks, U), new Uint8Array(16), fileKey);
  const P = permissionsValue();
  const perms = new Uint8Array(16);
  new DataView(perms.buffer).setInt32(0, P, true);
  perms.set([0xff, 0xff, 0xff, 0xff], 4);
  perms[8] = 'T'.charCodeAt(0);
  perms.set(textEncoder.encode('adb'), 9);
  perms.set(randomBytes(4), 12);
  const Perms = await aesCbcRaw(fileKey, new Uint8Array(16), perms); // single block = ECB
  const dictionary =
    `<< /Filter /Standard /V 5 /R 6 /Length 256 /P ${P} /EncryptMetadata true ` +
    `/CF << /StdCF << /AuthEvent /DocOpen /CFM /AESV3 /Length 32 >> >> /StmF /StdCF /StrF /StdCF ` +
    `/O ${hexStr(O)} /U ${hexStr(U)} /OE ${hexStr(OE)} /UE ${hexStr(UE)} /Perms ${hexStr(Perms)} >>`;
  return { fileKey, dictionary };
}

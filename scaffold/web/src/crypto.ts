// Client-side WebCrypto helpers for End-to-End Encrypted Private Notes.
// The server never receives private keys, the workspace key (WK), or note plaintext.

const KEYPAIR_STORAGE_PREFIX = 'sb_e2e_ecdh_v1_';

function toBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export async function getOrCreateIdentityKeyPair(sub: string): Promise<{
  publicKeyJwk: JsonWebKey;
  privateKey: CryptoKey;
}> {
  const key = `${KEYPAIR_STORAGE_PREFIX}${sub}`;
  const raw = localStorage.getItem(key);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { pub: JsonWebKey; priv: JsonWebKey };
      const privateKey = await crypto.subtle.importKey(
        'jwk',
        parsed.priv,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        ['deriveBits']
      );
      return { publicKeyJwk: parsed.pub, privateKey };
    } catch {
      // regenerate if corrupted
    }
  }

  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
  const [pub, priv] = await Promise.all([
    crypto.subtle.exportKey('jwk', pair.publicKey),
    crypto.subtle.exportKey('jwk', pair.privateKey),
  ]);
  localStorage.setItem(key, JSON.stringify({ pub, priv }));
  return { publicKeyJwk: pub, privateKey: pair.privateKey };
}

export async function generateWorkspaceKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

async function deriveWrappingKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  infoText: string
): Promise<CryptoKey> {
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: publicKey },
    privateKey,
    256
  );
  const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: new TextEncoder().encode(infoText),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function wrapWorkspaceKeyForMember(
  workspaceKey: CryptoKey,
  recipientPubJwk: JsonWebKey,
  workspace: string
): Promise<{ ephemeralPubJwk: JsonWebKey; iv: string; wrappedKey: string }> {
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const recipientPub = await crypto.subtle.importKey(
    'jwk',
    recipientPubJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  const wrappingKey = await deriveWrappingKey(eph.privateKey, recipientPub, `switchboard-wk:${workspace}`);
  const rawWk = await crypto.subtle.exportKey('raw', workspaceKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, rawWk);
  const ephemeralPubJwk = await crypto.subtle.exportKey('jwk', eph.publicKey);
  return {
    ephemeralPubJwk,
    iv: toBase64(iv),
    wrappedKey: toBase64(wrapped),
  };
}

export async function unwrapWorkspaceKey(
  envelope: { ephemeralPubJwk: JsonWebKey; iv: string; wrappedKey: string },
  myPrivateKey: CryptoKey,
  workspace: string
): Promise<CryptoKey> {
  const ephPub = await crypto.subtle.importKey(
    'jwk',
    envelope.ephemeralPubJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  const wrappingKey = await deriveWrappingKey(myPrivateKey, ephPub, `switchboard-wk:${workspace}`);
  const rawWk = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(envelope.iv) },
    wrappingKey,
    fromBase64(envelope.wrappedKey)
  );
  return crypto.subtle.importKey('raw', rawWk, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export async function encryptNote(
  workspaceKey: CryptoKey,
  plaintext: string,
  aad: string
): Promise<{ ciphertext: string; iv: string; aad: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: new TextEncoder().encode(aad),
    },
    workspaceKey,
    new TextEncoder().encode(plaintext)
  );
  return {
    ciphertext: toBase64(ct),
    iv: toBase64(iv),
    aad,
  };
}

export async function decryptNote(
  workspaceKey: CryptoKey,
  note: { ciphertext: string; iv: string; aad: string }
): Promise<string> {
  const pt = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: fromBase64(note.iv),
      additionalData: new TextEncoder().encode(note.aad),
    },
    workspaceKey,
    fromBase64(note.ciphertext)
  );
  return new TextDecoder().decode(pt);
}

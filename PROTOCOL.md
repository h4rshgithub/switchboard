# End-to-End Encrypted Private Notes Protocol

## Overview

Support agents can attach private internal notes to any conversation. Notes are encrypted end-to-end in the browser using the Web Crypto API before leaving the client. The Switchboard server stores and relays only ciphertext and key-wrapping envelopes; it never has access to plaintext notes, private identity keys, or workspace symmetric keys.

## Who Holds Which Key

1. **Agent Identity Keypair (`IK_pub`, `IK_priv`) — ECDH P-256**
   - Generated locally in each agent's browser (`crypto.subtle.generateKey`).
   - `IK_priv` stays in the browser (`localStorage` in this prototype; non-extractable IndexedDB `CryptoKey` in production) and is **never** sent to the server.
   - `IK_pub` (JWK) is uploaded to the server (`PUT /api/keys/me`) so other workspace members can wrap keys for this agent.

2. **Workspace Key (`WK`) — AES-256-GCM**
   - A 256-bit symmetric key shared among agents of a single workspace (`ws_acme`, `ws_globex`).
   - Generated in the browser by the first agent to initialize E2E notes for that workspace.
   - Stored in browser memory (`CryptoKey`) while the session is active, and persisted on the server **only** in per-recipient wrapped form (`workspace_key_envelopes`).

3. **Ephemeral Wrapping Key (`EK_pub`, `EK_priv`) — ECDH P-256 + HKDF-SHA256**
   - Generated fresh per recipient when sharing `WK` with a workspace member.
   - `ECDH(EK_priv, recipient.IK_pub)` -> `HKDF-SHA256(info="switchboard-wk:<workspace>")` -> `AES-256-GCM` wrapping key that encrypts the raw `WK`.

## What the Server Stores

- `user_keys`: `{ workspace, sub, publicKeyJwk, updated_at }` — public identity keys only.
- `workspace_key_envelopes`: `{ workspace, recipient_sub, ephemeralPubJwk, iv, wrappedKey, updated_at }` — `WK` encrypted under each recipient's `IK_pub`.
- `notes`: `{ note_id, workspace, contact, author, ciphertext, iv, aad, created_at }` — AES-256-GCM ciphertext (`ciphertext`), 96-bit random `iv`, and authenticated associated data (`aad = "<workspace>:<contact>:<author>"`).

## Three Attacks This Scheme Does NOT Stop

1. **Malicious Server Key Substitution (MITM on Key Directory)**
   Because `IK_pub` keys are distributed by the server without out-of-band fingerprint verification (e.g., safety numbers or signed transparency log), a compromised server could substitute its own `IK_pub` for a teammate and trick an online agent into wrapping `WK` for the attacker.

2. **Cross-Site Scripting (XSS) / Compromised Client**
   If an attacker injects malicious JavaScript into the web origin, that script runs with full access to `WK` in memory, `IK_priv` in browser storage, and decrypted note plaintexts.

3. **Metadata & Traffic Analysis**
   The server still observes which agent (`author`) posted a note, on which customer (`contact`), at what time (`created_at`), and the ciphertext length (which leaks approximate note length).

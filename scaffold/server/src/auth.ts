import { createHash, createPublicKey, randomBytes, verify as cryptoVerify, type JsonWebKey } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';
import { getRedis } from './redis.js';

export interface WorkspaceMembership {
  id: string;
  role: 'admin' | 'agent' | string;
}

export interface SessionUser {
  sub: string;
  name?: string;
  email?: string;
  workspaces: WorkspaceMembership[];
}

export const SESSION_COOKIE = 'sb_session';

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

let cachedJwks: { keys: Array<JsonWebKey & { kid?: string }>; fetchedAt: number } | undefined;

async function getJwks(): Promise<Array<JsonWebKey & { kid?: string }>> {
  if (cachedJwks && Date.now() - cachedJwks.fetchedAt < 60_000) {
    return cachedJwks.keys;
  }
  const res = await fetch(`${config.oidc.issuer}/jwks`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Failed to fetch JWKS: ${res.status}`);
  const body = (await res.json()) as { keys?: Array<JsonWebKey & { kid?: string }> };
  const keys = body.keys ?? [];
  cachedJwks = { keys, fetchedAt: Date.now() };
  return keys;
}

async function verifyIdToken(idToken: string, expectedNonce: string): Promise<Record<string, unknown>> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Malformed id_token');
  const [headB64, bodyB64, sigB64] = parts;

  const header = JSON.parse(Buffer.from(headB64, 'base64url').toString('utf8')) as {
    alg?: string;
    kid?: string;
  };
  if (header.alg !== 'RS256') throw new Error(`Unsupported alg: ${header.alg}`);

  let keys = await getJwks();
  let jwk = keys.find((k) => !header.kid || k.kid === header.kid);
  if (!jwk) {
    cachedJwks = undefined;
    keys = await getJwks();
    jwk = keys.find((k) => !header.kid || k.kid === header.kid);
  }
  if (!jwk) throw new Error('Matching JWK not found');

  const pubKey = createPublicKey({ key: jwk, format: 'jwk' });
  const valid = cryptoVerify(
    'RSA-SHA256',
    Buffer.from(`${headB64}.${bodyB64}`, 'utf8'),
    pubKey,
    Buffer.from(sigB64, 'base64url')
  );
  if (!valid) throw new Error('Invalid id_token signature');

  const claims = JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf8')) as Record<string, unknown>;
  const nowSec = Math.floor(Date.now() / 1000);
  if (claims.iss !== config.oidc.issuer) throw new Error('Invalid iss');
  if (claims.aud !== config.oidc.clientId) throw new Error('Invalid aud');
  if (typeof claims.exp !== 'number' || claims.exp <= nowSec) throw new Error('Expired id_token');
  if (claims.nonce !== expectedNonce) throw new Error('Invalid nonce');

  return claims;
}

export async function handleLogin(_req: Request, res: Response): Promise<void> {
  const state = randomBytes(16).toString('hex');
  const nonce = randomBytes(16).toString('hex');
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

  const redis = getRedis();
  await redis.set(
    `oidc:tx:${state}`,
    JSON.stringify({ nonce, codeVerifier }),
    'EX',
    600
  );

  const authUrl = new URL(`${config.oidc.issuer}/authorize`);
  authUrl.searchParams.set('client_id', config.oidc.clientId);
  authUrl.searchParams.set('redirect_uri', config.oidc.redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid profile email');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('nonce', nonce);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  res.redirect(302, authUrl.toString());
}

export async function handleCallback(req: Request, res: Response): Promise<void> {
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';

  if (!code || !state) {
    res.status(400).json({ error: 'Missing code or state' });
    return;
  }

  const redis = getRedis();
  const txKey = `oidc:tx:${state}`;
  const rawTx = await redis.get(txKey);
  await redis.del(txKey);

  if (!rawTx) {
    res.status(400).json({ error: 'Invalid or expired OIDC state' });
    return;
  }

  const tx = JSON.parse(rawTx) as { nonce: string; codeVerifier: string };

  const tokenRes = await fetch(`${config.oidc.issuer}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.oidc.redirectUri,
      client_id: config.oidc.clientId,
      client_secret: config.oidc.clientSecret,
      code_verifier: tx.codeVerifier,
    }),
    signal: AbortSignal.timeout(5000),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => '');
    res.status(401).json({ error: 'Token exchange failed', detail: text });
    return;
  }

  const tokenBody = (await tokenRes.json()) as { id_token?: string; access_token?: string };
  if (!tokenBody.id_token) {
    res.status(401).json({ error: 'Missing id_token' });
    return;
  }

  const claims = await verifyIdToken(tokenBody.id_token, tx.nonce);
  const user: SessionUser = {
    sub: String(claims.sub),
    name: typeof claims.name === 'string' ? claims.name : undefined,
    email: typeof claims.email === 'string' ? claims.email : undefined,
    workspaces: Array.isArray(claims.workspaces) ? (claims.workspaces as WorkspaceMembership[]) : [],
  };

  const sid = randomBytes(24).toString('hex');
  await redis.set(`sess:${sid}`, JSON.stringify(user), 'EX', 86400);

  res.cookie(SESSION_COOKIE, sid, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 86400 * 1000,
  });

  res.redirect(302, config.webOrigin);
}

export async function handleLogout(req: Request, res: Response): Promise<void> {
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies[SESSION_COOKIE];
  if (sid) {
    await getRedis().del(`sess:${sid}`);
  }
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
}

export async function getSessionFromCookie(cookieHeader: string | undefined): Promise<SessionUser | null> {
  const cookies = parseCookies(cookieHeader);
  const sid = cookies[SESSION_COOKIE];
  if (!sid) return null;
  const raw = await getRedis().get(`sess:${sid}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionUser;
  } catch {
    return null;
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = await getSessionFromCookie(req.headers.cookie);
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  (req as Request & { user: SessionUser }).user = user;
  next();
}

export function getWorkspaceRole(user: SessionUser, workspace: string): string | null {
  const m = user.workspaces.find((w) => w.id === workspace);
  return m ? m.role : null;
}

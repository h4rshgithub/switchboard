import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getWorkspaceRole, parseCookies, type SessionUser } from './auth.js';

describe('parseCookies', () => {
  it('parses multiple cookies and decodes values', () => {
    const parsed = parseCookies('foo=bar; sb_session=abc%3D123; theme=dark');
    assert.deepEqual(parsed, {
      foo: 'bar',
      sb_session: 'abc=123',
      theme: 'dark',
    });
  });

  it('returns empty object for undefined header', () => {
    assert.deepEqual(parseCookies(undefined), {});
  });
});

describe('getWorkspaceRole', () => {
  const ben: SessionUser = {
    sub: 'u_ben',
    workspaces: [{ id: 'ws_acme', role: 'agent' }],
  };

  it('returns role for member workspace and null for non-member', () => {
    assert.equal(getWorkspaceRole(ben, 'ws_acme'), 'agent');
    assert.equal(getWorkspaceRole(ben, 'ws_globex'), null);
  });
});

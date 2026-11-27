import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { shouldAdvanceStatus, verifyPigeonSignature } from './pigeon.js';

const SECRET = 'whsec_test_secret';

function sign(body: string, t: number, secret = SECRET): string {
  const mac = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${mac}`;
}

describe('verifyPigeonSignature', () => {
  const body = Buffer.from('{"id":"evt_1","type":"message.inbound"}', 'utf8');

  it('accepts a valid signature within 5 minutes', () => {
    const now = 1_700_000_000;
    const header = sign(body.toString('utf8'), now - 120);
    assert.equal(verifyPigeonSignature(header, body, SECRET, now), true);
  });

  it('rejects a signature older than 5 minutes (replay)', () => {
    const now = 1_700_000_000;
    const header = sign(body.toString('utf8'), now - 301);
    assert.equal(verifyPigeonSignature(header, body, SECRET, now), false);
  });

  it('accepts a signature at exactly 300 seconds', () => {
    const now = 1_700_000_000;
    const header = sign(body.toString('utf8'), now - 300);
    assert.equal(verifyPigeonSignature(header, body, SECRET, now), true);
  });

  it('rejects missing, malformed, or wrong-secret signatures', () => {
    const now = 1_700_000_000;
    assert.equal(verifyPigeonSignature(undefined, body, SECRET, now), false);
    assert.equal(verifyPigeonSignature('t=abc,v1=deadbeef', body, SECRET, now), false);
    assert.equal(verifyPigeonSignature(sign(body.toString('utf8'), now, 'wrong_secret'), body, SECRET, now), false);
  });

  it('rejects if raw body was modified', () => {
    const now = 1_700_000_000;
    const header = sign(body.toString('utf8'), now);
    const tampered = Buffer.from('{"id":"evt_1","type":"message.inbound" }', 'utf8');
    assert.equal(verifyPigeonSignature(header, tampered, SECRET, now), false);
  });
});

describe('shouldAdvanceStatus', () => {
  it('advances queued -> sent -> delivered', () => {
    assert.equal(shouldAdvanceStatus(1, 'sent'), 2);
    assert.equal(shouldAdvanceStatus(2, 'delivered'), 3);
  });

  it('does not regress delivered -> sent when webhooks arrive out of order', () => {
    assert.equal(shouldAdvanceStatus(3, 'sent'), null);
    assert.equal(shouldAdvanceStatus(3, 'delivered'), null);
    assert.equal(shouldAdvanceStatus(3, 'failed'), null);
  });

  it('ignores unknown status values', () => {
    assert.equal(shouldAdvanceStatus(1, 'unknown_status'), null);
  });
});

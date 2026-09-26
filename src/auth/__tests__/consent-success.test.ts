/**
 * The consent success page (docs/ARCHITECTURE.md section 5, BUILD_PLAN L5).
 *
 * It exists so a user can open the X-ray *before the first tool call*, and it must not cost the
 * OAuth walk anything: the code in the page's own link has to still work at `/token`, and a
 * client that drives `/consent` without our form must still get the bare 302 it has always got
 * (`test/e2e/oauth-walk.mjs` asserts exactly that, and it is not this block's file to change).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OAUTH_ROUTES } from '../../contracts/index.js';

import {
  FORM_HEADERS,
  createStubPairing,
  formBody,
  startAuthHarness,
  walkToCode,
  type Harness,
} from './harness.js';

let harness: Harness;
let pairing: ReturnType<typeof createStubPairing>;

beforeEach(async () => {
  pairing = createStubPairing();
  harness = await startAuthHarness({}, { pairing });
});

afterEach(async () => {
  await harness.close();
});

describe('the consent success page', () => {
  it('shows the persona id and a live dashboard link, then redirects itself', async () => {
    const walk = await walkToCode(harness, { showSuccess: true });

    expect(walk.consent.status).toBe(200);
    expect(walk.consent.headers.get('content-type')).toContain('text/html');
    expect(walk.consentBody).toContain('per_ava_stone');
    expect(walk.consentBody).toContain('BANK-TEST-XRAY-23');
    expect(walk.consentBody).toContain('https://example.test/xray/s/BANK-TEST-XRAY-23');
    // A new tab: following the link in this window would navigate the popup off the OAuth flow.
    expect(walk.consentBody).toContain('target="_blank"');
    expect(walk.consentBody).toContain('rel="noopener"');
    // The redirect stays automatic in both a JavaScript and a no-JavaScript browser.
    expect(walk.consentBody).toContain('http-equiv="refresh"');
    expect(walk.consentBody).toContain('window.location.replace');
    expect(pairing.created).toEqual([
      harness.emitter.ofType('auth.grant.created')[0]?.data.login_id,
    ]);
  });

  it('keeps the security headers of invariant 15 on the success page', async () => {
    const walk = await walkToCode(harness, { showSuccess: true });

    expect(walk.consent.headers.get('x-frame-options')).toBe('DENY');
    expect(walk.consent.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    // The page carries the authorization code in a link; neither a cache nor the X-ray tab's
    // Referer may keep it.
    expect(walk.consent.headers.get('cache-control')).toBe('no-store');
    expect(walk.consent.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('hands over a code that still works at /token', async () => {
    const walk = await walkToCode(harness, { showSuccess: true });
    expect(walk.callbackUrl).toContain(walk.redirectUri);
    expect(new URL(walk.callbackUrl ?? '').searchParams.get('state')).toBe(walk.state);
    expect(new URL(walk.callbackUrl ?? '').searchParams.get('iss')).toBe(harness.baseUrl);

    const response = await harness.fetch(OAUTH_ROUTES.token, {
      method: 'POST',
      headers: FORM_HEADERS,
      body: formBody({
        grant_type: 'authorization_code',
        code: walk.code ?? '',
        code_verifier: walk.verifier,
        redirect_uri: walk.redirectUri,
        client_id: walk.clientId,
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { access_token: string };
    expect(body.access_token).toContain('mockbank_user_tok_');
  });

  it('still answers the bare 302 for a client that does not send our form field', async () => {
    const walk = await walkToCode(harness);

    expect(walk.consent.status).toBe(302);
    expect(walk.consent.headers.get('location')).toContain('code=');
    expect(pairing.created).toEqual([]);
  });

  it('renders the hidden field on the consent page, so a browser opts in by using the form', async () => {
    const walk = await walkToCode(harness, { showSuccess: true });
    expect(walk.consentHtml).toContain('name="show_success" value="1"');
  });

  it('is switched off entirely by consentSuccessRedirectMs: 0', async () => {
    const off = await startAuthHarness({}, { pairing, consentSuccessRedirectMs: 0 });
    try {
      const walk = await walkToCode(off, { showSuccess: true });
      expect(walk.consentHtml).not.toContain('show_success');
      // Even a caller that sends the field anyway gets the redirect.
      expect(walk.consent.status).toBe(302);
      expect(pairing.created).toEqual([]);
    } finally {
      await off.close();
    }
  });

  it('explains the missing link when xray:read was not granted', async () => {
    const walk = await walkToCode(harness, {
      scopes: 'profile accounts:read xray:read',
      approve: ['profile', 'accounts:read'],
      showSuccess: true,
    });

    expect(walk.consent.status).toBe(200);
    expect(walk.consentBody).toContain('per_ava_stone');
    expect(walk.consentBody).toContain('unticked');
    expect(walk.consentBody).not.toContain('/xray/s/');
    expect(pairing.created).toEqual([]);
  });

  it('degrades to a readable page when no pairing service is wired in', async () => {
    const unpaired = await startAuthHarness();
    try {
      const walk = await walkToCode(unpaired, { showSuccess: true });
      expect(walk.consent.status).toBe(200);
      expect(walk.consentBody).toContain('xray_get_session_link');
      expect(walk.code).toBeTruthy();
    } finally {
      await unpaired.close();
    }
  });

  it('survives a pairing service that throws: the walk completes without a link', async () => {
    const broken = await startAuthHarness(
      {},
      {
        pairing: {
          async createCode() {
            throw new Error('the pairing store is down');
          },
          async exchange() {
            return { ok: false, reason: 'unknown_code' };
          },
          async exchangeAdminToken() {
            return { ok: false, reason: 'unknown_code' };
          },
        },
      },
    );
    try {
      const walk = await walkToCode(broken, { showSuccess: true });
      expect(walk.consent.status).toBe(200);
      expect(walk.consentBody).toContain('xray_get_session_link');
      expect(walk.code).toBeTruthy();
    } finally {
      await broken.close();
    }
  });

  it('never shows the page for a denied consent', async () => {
    const walk = await walkToCode(harness, { showSuccess: true, decision: 'deny' });

    expect(walk.consent.status).toBe(302);
    expect(walk.consent.headers.get('location')).toContain('error=access_denied');
  });

  it('says so when the consent extended a grant this browser already had (ADR-14)', async () => {
    const first = await walkToCode(harness, { scopes: 'profile accounts:read' });
    const second = await walkToCode(harness, {
      clientId: first.clientId,
      scopes: 'profile accounts:read',
      showSuccess: true,
    });

    const grantId = harness.emitter.ofType('auth.grant.created')[0]?.data.grant_id ?? '';
    expect(grantId).not.toBe('');
    expect(second.consentBody).toContain(grantId);
    expect(second.consentBody).toContain('extended the authorization');
  });
});

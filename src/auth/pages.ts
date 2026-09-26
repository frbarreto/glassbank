/**
 * The server-rendered authorization-server pages (block: auth).
 *
 * Plain HTML, no client-side framework and no bundler (CLAUDE.md "Don't"). Every page carries
 * the signed `txn` JWT and the CSRF token as hidden fields (invariant 15); the headers that go
 * with them (`X-Frame-Options`, `Content-Security-Policy: frame-ancestors 'none'`) are set by
 * the route handlers in `routes.ts`.
 *
 * All user-supplied values are escaped: the pages echo a client name, a redirect URI and a
 * persona id that a stranger controls.
 */
import {
  CONSENT_PRECHECKED_SCOPES,
  SCOPES,
  TOKEN_LIFETIMES_SECONDS,
  authLevelForScopes,
  isWriteScope,
  type PairingCode,
  type Persona,
  type Scope,
} from '../contracts/index.js';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0;
         padding: 2.5rem 1.25rem; background: #f6f6f8; color: #17171b; }
  main { max-width: 34rem; margin: 0 auto; background: #fff; border: 1px solid #e2e2e8;
         border-radius: 10px; padding: 1.75rem 1.75rem 2rem; }
  h1 { font-size: 1.35rem; margin: 0 0 0.25rem; }
  p.lede { margin: 0 0 1.5rem; color: #55555f; }
  fieldset { border: 1px solid #e2e2e8; border-radius: 8px; margin: 0 0 1.25rem; padding: 0.9rem 1rem; }
  legend { font-weight: 600; padding: 0 0.35rem; }
  label { display: block; margin: 0.4rem 0; }
  label.scope { display: flex; gap: 0.55rem; align-items: baseline; }
  code { background: #ececf1; padding: 0.08rem 0.32rem; border-radius: 3px; font-size: 0.9em; }
  input[type="text"] { width: 100%; box-sizing: border-box; padding: 0.5rem 0.6rem;
                       border: 1px solid #c8c8d2; border-radius: 6px; font: inherit; }
  button { font: inherit; font-weight: 600; padding: 0.6rem 1.1rem; border: 0; border-radius: 6px;
           background: #1b53d0; color: #fff; cursor: pointer; }
  .muted { color: #6a6a75; font-size: 0.9rem; }
  .warn { color: #8a3d00; }
  .facts { margin: 0 0 1.25rem; padding: 0.75rem 0.9rem; background: #f3f6ff;
           border: 1px solid #d7e0fb; border-radius: 8px; font-size: 0.92rem; }
  .facts dt { font-weight: 600; }
  .facts dd { margin: 0 0 0.4rem; }
  .banner { background: #fff6e5; border: 1px solid #f0d9a8; border-radius: 8px;
            padding: 0.6rem 0.8rem; margin: 0 0 1.25rem; font-size: 0.92rem; }
  .ok { background: #eaf7ee; border: 1px solid #b9e2c6; border-radius: 8px;
        padding: 0.6rem 0.8rem; margin: 0 0 1.25rem; font-size: 0.92rem; }
  .pair { display: block; word-break: break-all; margin: 0.35rem 0 0.15rem; font-weight: 600; }
  .id { font-size: 1.05rem; }
  a.button { display: inline-block; text-decoration: none; }
`;

function page(title: string, body: string, head = ''): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
${head}    <title>${escapeHtml(title)} - Glass Bank</title>
    <style>${STYLE}</style>
  </head>
  <body>
    <main>
${body}
    </main>
  </body>
</html>
`;
}

export interface LoginPageInput {
  readonly txn: string;
  readonly csrf: string;
  readonly personas: readonly Persona[];
  readonly clientName: string;
  readonly clientReconstructed: boolean;
  readonly requestedScopes: readonly Scope[];
  readonly knownPersonaId: string | null;
  readonly error: string | null;
  readonly loginPath: string;
}

/** Step 1: pick a seeded persona, create a demo customer, or paste an existing `per_` id. */
export function renderLoginPage(input: LoginPageInput): string {
  const personaOptions = input.personas
    .map(
      (persona, index) => `
        <label>
          <input type="radio" name="choice" value="${escapeHtml(persona.id)}"${
            index === 0 && input.knownPersonaId === null ? ' checked' : ''
          } />
          <strong>${escapeHtml(persona.name)}</strong>
          <span class="muted">${escapeHtml(persona.kind)} &middot; <code>${escapeHtml(persona.id)}</code></span>
        </label>`,
    )
    .join('');

  const returning =
    input.knownPersonaId === null
      ? ''
      : `
        <label>
          <input type="radio" name="choice" value="${escapeHtml(input.knownPersonaId)}" checked />
          <strong>Continue as the customer this browser used before</strong>
          <span class="muted"><code>${escapeHtml(input.knownPersonaId)}</code></span>
        </label>`;

  return page(
    'Sign in',
    `      <h1>Sign in to Glass Bank</h1>
      <p class="lede">Glass Bank is a demo. Every account, card and transaction is fake, and no
      password is required: pick who you want to be.</p>
      ${
        input.error === null
          ? ''
          : `<p class="banner warn">${escapeHtml(input.error)}</p>`
      }
      <p class="facts"><strong>${escapeHtml(input.clientName)}</strong> wants to connect${
        input.clientReconstructed
          ? ' <span class="muted">(this client id was not recognised and was rebuilt with the standard callback URLs)</span>'
          : ''
      }.</p>
      <form method="post" action="${escapeHtml(input.loginPath)}">
        <input type="hidden" name="txn" value="${escapeHtml(input.txn)}" />
        <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}" />
        <fieldset>
          <legend>Demo customers</legend>
          ${returning}${personaOptions}
          <label>
            <input type="radio" name="choice" value="__new__" />
            <strong>Create a demo customer</strong>
            <span class="muted">a fresh persona with its own generated data</span>
          </label>
        </fieldset>
        <fieldset>
          <legend>Recover an existing customer</legend>
          <label for="persona_id" class="muted">Paste a <code>per_</code> id you were given
          earlier (<code>get_current_user</code> returns it). Choosing this overrides the
          selection above.</label>
          <input type="text" id="persona_id" name="persona_id" placeholder="per_..."
                 autocomplete="off" spellcheck="false" />
        </fieldset>
        <button type="submit">Continue</button>
      </form>`,
  );
}

export interface ConsentPageInput {
  readonly txn: string;
  readonly csrf: string;
  readonly persona: Persona;
  readonly clientName: string;
  readonly requestedScopes: readonly Scope[];
  readonly extendingGrantId: string | null;
  readonly error: string | null;
  readonly consentPath: string;
  /**
   * Asks `/consent` for the success interstitial instead of the bare 302 (see
   * `renderConsentSuccessPage`). It is a hidden field of *this* form rather than a header sniff,
   * so the page a browser was given decides, and a client that drives `/consent` programmatically
   * - the scripted walk in `test/e2e`, a future CLI - keeps getting the plain redirect it expects.
   */
  readonly showSuccessPage: boolean;
}

const SCOPE_LABELS: Readonly<Record<Scope, string>> = {
  profile: 'Know which demo customer you are',
  'accounts:read': 'Read your accounts and balances',
  'transactions:read': 'Read your transactions',
  'cards:read': 'Read your cards',
  'cards:write': 'Lock and unlock your cards',
  'transfers:read': 'Read your transfers',
  'transfers:write': 'Create transfers from your accounts',
  'bills:read': 'Read your bills',
  'payees:read': 'Read your saved payees',
  'xray:read': 'Give you a link to the live X-ray of this session',
};

/** Step 2: consent. Read scopes are pre-checked, write scopes are opt-in (TOOL_CATALOG 2). */
export function renderConsentPage(input: ConsentPageInput): string {
  const requested = SCOPES.filter((scope) => input.requestedScopes.includes(scope));
  const rows = requested
    .map((scope) => {
      const preChecked = CONSENT_PRECHECKED_SCOPES.includes(scope);
      const disabled = scope === 'profile';
      return `
          <label class="scope">
            <input type="checkbox" name="scope" value="${escapeHtml(scope)}"${
              preChecked ? ' checked' : ''
            }${disabled ? ' disabled' : ''} />
            <span><code>${escapeHtml(scope)}</code> &mdash; ${escapeHtml(SCOPE_LABELS[scope])}${
              isWriteScope(scope)
                ? ' <span class="muted">(write; leaving it unchecked keeps this connection read-only)</span>'
                : ''
            }</span>
          </label>`;
    })
    .join('');

  const preCheckedLevel = authLevelForScopes(
    requested.filter((scope) => CONSENT_PRECHECKED_SCOPES.includes(scope)),
  );
  const readOnlyDays = TOKEN_LIFETIMES_SECONDS.refreshReadOnly / 86_400;
  const readWriteHours = TOKEN_LIFETIMES_SECONDS.refreshReadWrite / 3_600;

  return page(
    'Authorize',
    `      <h1>Authorize ${escapeHtml(input.clientName)}</h1>
      <p class="lede">You are signed in as <strong>${escapeHtml(input.persona.name)}</strong>
      (<code>${escapeHtml(input.persona.id)}</code>). Keep that id: it is how you come back to this
      demo customer later.</p>
      ${
        input.error === null
          ? ''
          : `<p class="banner warn">${escapeHtml(input.error)}</p>`
      }
      ${
        input.extendingGrantId === null
          ? ''
          : `<p class="banner">This browser already authorized this client. Approving again
             extends the existing grant <code>${escapeHtml(input.extendingGrantId)}</code>
             instead of creating a new one, so an open X-ray keeps working.</p>`
      }
      <form method="post" action="${escapeHtml(input.consentPath)}">
        <input type="hidden" name="txn" value="${escapeHtml(input.txn)}" />
        <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}" />
        <input type="hidden" name="scope" value="profile" />${
          input.showSuccessPage ? '\n        <input type="hidden" name="show_success" value="1" />' : ''
        }
        <fieldset>
          <legend>Requested access</legend>${rows}
        </fieldset>
        <dl class="facts">
          <dt>Authorization level with the boxes as they stand</dt>
          <dd><code>${escapeHtml(preCheckedLevel)}</code> &mdash; checking any write scope makes it
          <code>read_write</code>.</dd>
          <dt>How long this stays valid</dt>
          <dd>Access tokens last 1 hour. The connection is refreshed for up to
          ${readOnlyDays} days while it is read-only, or ${readWriteHours} hours once it can
          write, counted from the last use.</dd>
        </dl>
        <button type="submit" name="decision" value="approve">Approve</button>
        <button type="submit" name="decision" value="deny"
                style="background:#e6e6ec;color:#3a3a44;margin-left:0.5rem">Deny</button>
      </form>`,
  );
}

/** An ISO instant a human can read, in UTC; the raw string if it does not parse. */
function readableUtc(value: string): string {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toUTCString();
}

/** Why the success page has no pairing link to show. */
export type PairingAbsence = 'not_requested' | 'unavailable';

export interface ConsentSuccessPageInput {
  readonly persona: Persona;
  readonly clientName: string;
  readonly grantedScopes: readonly Scope[];
  /** Where the browser is going next: the client callback, `code`, `state` and `iss` included. */
  readonly callbackUrl: string;
  /** The live dashboard link (ADR-10), or `null` with the reason it is missing. */
  readonly pairing: PairingCode | null;
  readonly pairingAbsence: PairingAbsence | null;
  /** How long the page stays on screen before it redirects itself. */
  readonly redirectMs: number;
  /** Set when this consent extended an existing grant instead of creating one (ADR-14). */
  readonly extendedGrantId: string | null;
}

/**
 * Step 3: the consent **success** page (docs/ARCHITECTURE.md section 5).
 *
 * It exists so a user can open the X-ray *before the first tool call*: after this page the
 * browser hands the code to the client and the window closes, and the pairing link is then only
 * reachable through the `xray_get_session_link` tool. The redirect stays automatic - a
 * `<meta http-equiv="refresh">` for a browser with no JavaScript, a timer for one with it, and a
 * "Continue now" link for a user who does not want to wait - so no client has to learn a new
 * step. The dashboard link opens in a new tab (`target="_blank"`): clicking it in this window
 * would navigate the popup away from the OAuth flow and strand the client.
 *
 * The page carries the authorization code in the redirect URL, as every OAuth success page does.
 * `Referrer-Policy: no-referrer` and `Cache-Control: no-store` (set in `routes.ts`) are what keep
 * that from leaking into the X-ray tab's `Referer` or a shared cache.
 */
export function renderConsentSuccessPage(input: ConsentSuccessPageInput): string {
  const seconds = Math.max(1, Math.round(input.redirectMs / 1000));
  const expiresAt = readableUtc(input.pairing?.expires_at ?? '');
  const callback = escapeHtml(input.callbackUrl);
  const scopeList = input.grantedScopes
    .map((scope) => `<code>${escapeHtml(scope)}</code>`)
    .join(' ');

  const pairingBlock =
    input.pairing !== null
      ? `        <dt>Watch this connection live</dt>
        <dd>
          <a class="pair" href="${escapeHtml(input.pairing.url)}" target="_blank"
             rel="noopener">${escapeHtml(input.pairing.url)}</a>
          <span class="muted">Pairing code <code>${escapeHtml(input.pairing.code)}</code>. It
          opens in a new tab, works on any device, and stays valid until
          ${escapeHtml(expiresAt)}.</span>
        </dd>`
      : `        <dt>Watch this connection live</dt>
        <dd><span class="muted">${
          input.pairingAbsence === 'not_requested'
            ? 'You left the <code>xray:read</code> box unticked, so no dashboard link was created. Authorize again with that scope to get one.'
            : 'The dashboard link could not be created right now. Ask the assistant to call <code>xray_get_session_link</code> and it will hand you one.'
        }</span></dd>`;

  return page(
    'Connected',
    `      <h1>You are connected</h1>
      <p class="lede"><strong>${escapeHtml(input.clientName)}</strong> can now use Glass Bank as
      you. Sending you back in <span id="countdown">${seconds}</span>&hellip;</p>
      ${
        input.extendedGrantId === null
          ? ''
          : `<p class="ok">This extended the authorization this browser already had
             (<code>${escapeHtml(input.extendedGrantId)}</code>), so an open X-ray keeps working.</p>`
      }
      <dl class="facts">
        <dt>Your demo customer</dt>
        <dd><code class="id">${escapeHtml(input.persona.id)}</code> &mdash;
        ${escapeHtml(input.persona.name)}.
        <span class="muted">Keep this id: pasting it on the sign-in page is how you come back to
        this customer later.</span></dd>
        <dt>Granted</dt>
        <dd>${scopeList}</dd>
${pairingBlock}
      </dl>
      <p><a class="button" id="continue" href="${callback}">Continue now</a></p>
      <p class="muted">If nothing happens, use the link above to finish connecting.</p>
      <script>
        (function () {
          var target = document.getElementById('continue');
          var countdown = document.getElementById('countdown');
          var left = ${seconds};
          var tick = setInterval(function () {
            left -= 1;
            if (countdown) countdown.textContent = String(left > 0 ? left : 0);
            if (left <= 0) {
              clearInterval(tick);
              window.location.replace(target.href);
            }
          }, 1000);
        })();
      </script>`,
    `    <meta http-equiv="refresh" content="${seconds};url=${callback}" />\n`,
  );
}

/** Shown when a `txn` is missing, expired or does not match the CSRF cookie (invariant 15). */
export function renderErrorPage(title: string, detail: string): string {
  return page(
    title,
    `      <h1>${escapeHtml(title)}</h1>
      <p class="lede">${escapeHtml(detail)}</p>
      <p class="muted">Close this window and start the connection again from your MCP client.</p>`,
  );
}

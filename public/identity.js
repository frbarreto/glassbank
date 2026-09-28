/**
 * Who is on the other end (block: dashboard, contracts v0.10, D-29).
 *
 * Three answers, never merged into one: a Web Bot Auth signature this server **verified** against
 * the key the agent publishes, a name the client **claimed** (`clientInfo`, the `User-Agent`), or
 * nothing at all. Only the first is evidence, so only the first is drawn as a statement ("signed by
 * chatgpt.com"); a claim is always drawn as a claim ("claims claude-ai"), and a signature that did
 * not check out says why.
 *
 * The session's identity comes from the server (`XraySessionSummary.identity`, computed by the read
 * model over every request of the session) and is folded here as well from each `http.request`
 * the page holds, so a live session updates without a refetch.
 *
 * Pure functions returning data or virtual nodes. No DOM, no network, no clock.
 */
import { cx, h } from './h.js';

/** Lower is stronger evidence; the server ranks them the same way (`src/xray/verdicts.ts`). */
export const VERDICT_RANK = {
  verified: 0,
  invalid_signature: 1,
  unknown_key: 2,
  replayed: 3,
  expired: 4,
  not_yet_valid: 5,
  directory_unreachable: 6,
  unsupported: 7,
  malformed: 8,
  not_checked: 9,
  unsigned: 10,
};

/** How each verdict reads on the page. */
export const VERDICT_WORDS = {
  verified: 'verified',
  invalid_signature: 'signature does not match',
  unknown_key: 'key not published by the agent',
  directory_unreachable: 'key directory unreachable',
  expired: 'signature expired',
  not_yet_valid: 'signature from the future',
  replayed: 'nonce replayed',
  malformed: 'malformed signature',
  unsupported: 'signature this server cannot check',
  unsigned: 'unsigned',
  not_checked: 'signature not checked',
};

export function emptyIdentity() {
  return {
    signature_verdict: null,
    signed_agent: null,
    keyid: null,
    signed_requests: 0,
    verified_requests: 0,
    challenged: false,
    client_name: null,
    client_version: null,
    user_agent: null,
    anthropic_egress: false,
  };
}

/** The stronger of two verdicts; `unsigned` never replaces a verdict a signature earned. */
export function strongerVerdict(current, next) {
  if (!next || next === 'unsigned') return current ?? null;
  if (!current) return next;
  return (VERDICT_RANK[next] ?? 99) < (VERDICT_RANK[current] ?? 99) ? next : current;
}

/** Folds one `http.request` of the session into its identity. Mutates `identity`. */
export function foldHttpIdentity(identity, data = {}) {
  if (!identity) return identity;
  if (typeof data.user_agent === 'string' && data.user_agent) identity.user_agent = data.user_agent;
  if (data.anthropic_egress === true) identity.anthropic_egress = true;
  const signature = data.signature;
  if (signature && typeof signature === 'object') {
    if (signature.challenge_sent) identity.challenged = true;
    if (signature.present) {
      identity.signed_requests += 1;
      if (signature.verdict === 'verified') identity.verified_requests += 1;
    }
    const stronger = strongerVerdict(identity.signature_verdict, signature.verdict);
    if (stronger !== identity.signature_verdict) {
      identity.signature_verdict = stronger;
      identity.signed_agent = signature.agent ?? null;
      identity.keyid = signature.keyid ?? null;
    }
  }
  return identity;
}

/**
 * The server's identity and the page's own fold, combined: the stronger verdict wins, counts take
 * the larger of the two (the server saw requests older than the page's window), names fill gaps.
 */
export function mergeIdentity(local, server) {
  const base = { ...emptyIdentity(), ...(local ?? {}) };
  if (!server || typeof server !== 'object') return base;
  const verdict = strongerVerdict(base.signature_verdict, server.signature_verdict);
  const fromServer = verdict !== base.signature_verdict;
  return {
    signature_verdict: verdict,
    signed_agent: fromServer ? (server.signed_agent ?? null) : base.signed_agent,
    keyid: fromServer ? (server.keyid ?? null) : base.keyid,
    signed_requests: Math.max(base.signed_requests, Number(server.signed_requests ?? 0)),
    verified_requests: Math.max(base.verified_requests, Number(server.verified_requests ?? 0)),
    challenged: base.challenged || Boolean(server.challenged),
    client_name: base.client_name ?? server.client_name ?? null,
    client_version: base.client_version ?? server.client_version ?? null,
    user_agent: base.user_agent ?? server.user_agent ?? null,
    anthropic_egress: base.anthropic_egress || Boolean(server.anthropic_egress),
  };
}

/** `https://chatgpt.com` -> `chatgpt.com`; anything unparseable comes back as it was. */
export function agentHost(agent) {
  if (!agent) return null;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(agent) ? agent : `https://${agent}`).host;
  } catch {
    return String(agent);
  }
}

/**
 * What the page may say about a session's other end. `kind` is `verified`, `signature` (a
 * signature arrived and did not verify), `claimed` (only names the client chose) or `unknown`.
 */
export function describeIdentity(session) {
  const identity = mergeIdentity(session?.identity, null);
  const client = session?.client ?? null;
  const claimedName = identity.client_name ?? client?.name ?? null;
  const claimedVersion = identity.client_version ?? client?.version ?? null;
  const claimed = claimedName
    ? `${claimedName}${claimedVersion ? ` ${claimedVersion}` : ''}`
    : null;
  const userAgent = identity.user_agent ?? null;
  const verdict = identity.signature_verdict;
  const host = agentHost(identity.signed_agent);
  const invited = identity.challenged
    ? ' This server invited the client to sign (Accept-Signature).'
    : '';
  const claimNote = `${claimed ? `clientInfo says "${claimed}"` : 'no clientInfo'}${
    userAgent ? `, User-Agent says "${userAgent}"` : ''
  }: names the client chose to send, not verified.`;

  if (verdict === 'verified') {
    return {
      kind: 'verified',
      label: `signed by ${host ?? 'an agent'}`,
      tone: 'ok',
      claimed,
      userAgent,
      host,
      verdict,
      title: `A Web Bot Auth signature on ${identity.verified_requests} request${
        identity.verified_requests === 1 ? '' : 's'
      } of this session verified against the key ${host ?? 'the agent'} publishes (${
        identity.signed_agent
      }). ${claimNote}`,
    };
  }
  if (verdict && verdict !== 'unsigned') {
    return {
      kind: 'signature',
      label: `${VERDICT_WORDS[verdict] ?? verdict}${host ? ` · ${host}` : ''}`,
      tone: 'warn',
      claimed,
      userAgent,
      host,
      verdict,
      title: `A request of this session carried a Web Bot Auth signature naming ${
        identity.signed_agent ?? 'no agent'
      }, and it did not verify: ${VERDICT_WORDS[verdict] ?? verdict}. The name is therefore a claim. ${claimNote}`,
    };
  }
  if (claimed || userAgent) {
    return {
      kind: 'claimed',
      label: `claims ${claimedName ?? userAgent} · unsigned`,
      tone: 'neutral',
      claimed,
      userAgent,
      host: null,
      verdict: null,
      title: `No request of this session carried a Web Bot Auth signature, so nothing proves who this is. ${claimNote}${invited}`,
    };
  }
  return {
    kind: 'unknown',
    label: 'unidentified · unsigned',
    tone: 'neutral',
    claimed: null,
    userAgent: null,
    host: null,
    verdict: null,
    title: `This session sent no clientInfo, no User-Agent the page holds and no signature.${invited}`,
  };
}

/** The badge the session head, the rail and the overview draw. */
export function identityBadge(session, options = {}) {
  const described = describeIdentity(session);
  return h(
    'span',
    {
      class: cx('identity-badge', `identity-${described.kind}`, options.class),
      title: described.title,
      'data-identity': described.kind,
    },
    h(
      'span',
      { class: 'identity-mark', 'aria-hidden': 'true' },
      described.kind === 'verified' ? '✓' : described.kind === 'signature' ? '!' : '?',
    ),
    h('span', { class: 'identity-label' }, described.label),
  );
}

/** A verdict badge on its own, for a single request (the raw request callout, the overview rows). */
export function verdictBadge(verdict, agent) {
  if (!verdict) {
    return h(
      'span',
      { class: 'identity-badge identity-claimed', title: 'No request carried a signature.' },
      h('span', { class: 'identity-label' }, 'unsigned'),
    );
  }
  const kind =
    verdict === 'verified' ? 'verified' : verdict === 'unsigned' ? 'claimed' : 'signature';
  const host = agentHost(agent);
  return h(
    'span',
    {
      class: cx('identity-badge', `identity-${kind}`),
      title: agent ? `Signature-Agent ${agent}` : VERDICT_WORDS[verdict],
    },
    h(
      'span',
      { class: 'identity-mark', 'aria-hidden': 'true' },
      kind === 'verified' ? '✓' : kind === 'signature' ? '!' : '?',
    ),
    h(
      'span',
      { class: 'identity-label' },
      kind === 'verified'
        ? `signed by ${host}`
        : `${VERDICT_WORDS[verdict] ?? verdict}${host ? ` · ${host}` : ''}`,
    ),
  );
}

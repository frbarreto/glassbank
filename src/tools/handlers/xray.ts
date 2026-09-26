/**
 * `xray_get_session_link`: the pairing code and link to the live dashboard.
 *
 * The code is minted by the injected `Pairing` implementation and is bound to the **login**, not
 * to this grant (ADR-10, A-24): a step-up, a reconnect or a second device must not need a new
 * link, and one viewer sees every grant of that login and nothing else. `xray.pairing.created` is
 * emitted by the pairing implementation itself, so nothing is emitted here.
 */
import { toolError, toolText } from '../../contracts/index.js';

import type { ToolCallHandler } from '../types.js';

const getSessionLink: ToolCallHandler = async (context) => {
  const loginId = context.auth.login_id;
  if (loginId === null) {
    return toolError(
      'this connection has no login to pair a dashboard with: it was authorized before the login cookie existed, so reconnect the connector to get a link',
    );
  }
  const code = await context.pairing.createCode({ login_id: loginId });
  const lines = [
    `Open this to watch what happens behind the scenes: ${code.url}`,
    `Pairing code: ${code.code} (type it at ${context.publicBaseUrl}/xray if the link is not clickable).`,
    `The link covers every session of this login, works more than once and expires at ${code.expires_at}.`,
    'Show the link to the user exactly as it is written: it only works verbatim.',
  ];
  return toolText(lines.join('\n'), {
    code: code.code,
    url: code.url,
    expires_at: code.expires_at,
  });
};

export const XRAY_HANDLERS: Record<string, ToolCallHandler> = {
  xray_get_session_link: getSessionLink,
};

/**
 * `get_current_user` and `get_tool_availability`.
 *
 * Both answer from the verified `AuthContext` and the frozen catalog; neither reads a bank
 * record, which is why `profile` (implicit in every grant) is the only scope they need.
 *
 * `get_current_user` carries the `boot_id` on purpose (A-15): every bank write lives in an
 * in-memory overlay, so after a restart a card the user locked is active again, and a different
 * `boot_id` is the only way the model can explain that instead of doubting the user.
 */
import {
  formatScopeString,
  toolText,
  type FeatureFlag,
  type GrantView,
  type Scope,
} from '../../contracts/index.js';

import { availabilityTableFor } from '../availability.js';
import { correlationOf } from '../rationale.js';
import type { ToolCallHandler } from '../types.js';

const getCurrentUser: ToolCallHandler = async (context) => {
  const { auth } = context;
  const structured = {
    persona_id: auth.persona.id,
    persona_name: auth.persona.name,
    persona_kind: auth.persona.kind,
    shared_persona: auth.persona.shared,
    login_id: auth.login_id,
    grant_id: auth.grant_id,
    scopes: [...auth.scopes],
    auth_level: auth.auth_level,
    token_expires_at: auth.token_expires_at,
    xray_session_id: auth.xs,
    boot_id: auth.boot_id,
  };
  const lines = [
    `You are connected to Glass Bank as ${auth.persona.name} (${auth.persona.id}), a ${auth.persona.kind} customer.`,
    auth.persona.shared
      ? 'This is one of the shared demo customers: its data is the same for everyone, and any change you make is visible only to this connection.'
      : 'This is a generated demo customer. Keep its id to come back to it later from the sign-in page.',
    `Authorization level: ${auth.auth_level}. Scopes: ${formatScopeString(auth.scopes as Scope[])}.`,
    `The access token expires at ${auth.token_expires_at}.`,
    `X-ray session: ${auth.xs ?? 'not started'}. Server boot id: ${auth.boot_id} (a different boot id means the server restarted and in-memory changes were lost).`,
  ];
  return toolText(lines.join('\n'), structured);
};

const getToolAvailability: ToolCallHandler = async (context) => {
  const grant: GrantView = { scopes: context.auth.scopes, auth_level: context.auth.auth_level };
  const flags = context.featureFlags as readonly FeatureFlag[];
  const table = availabilityTableFor(grant, flags);

  // The dashboard's possibility-space panel is fed by `catalog.*`; a table the model asked for is
  // the same table, from the other source (`CatalogAvailabilityData.source`).
  context.xray.emit(
    'catalog.availability',
    {
      content_hash: table.content_hash,
      availability: [...table.tools],
      feature_flags: [...table.feature_flags],
      source: 'get_tool_availability',
    },
    correlationOf(context.auth, context.requestId),
  );

  const lines = table.tools.map((row) => {
    if (row.available) return `${row.tool}: available`;
    const reasons = row.unavailable_reasons.join(', ');
    const missing =
      row.missing_scopes.length > 0 ? ` (still needs ${row.missing_scopes.join(' ')})` : '';
    return `${row.tool}: ${row.listed ? 'listed but unavailable' : 'hidden'} - ${reasons}${missing}`;
  });
  const header = `Tool availability for this connection (${context.auth.auth_level}, catalog ${table.content_hash}):`;
  return toolText([header, ...lines].join('\n'), {
    content_hash: table.content_hash,
    tools: [...table.tools],
    feature_flags: [...table.feature_flags],
  });
};

export const META_HANDLERS: Record<string, ToolCallHandler> = {
  get_current_user: getCurrentUser,
  get_tool_availability: getToolAvailability,
};

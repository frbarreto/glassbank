/**
 * Tool calls that have started and not finished (block: mcp).
 *
 * `tool.call.cancelled` exists because a `tools/call` can end without a result in two ways this
 * server can actually see: claude.ai drops the HTTP request (a 300 000 ms budget expired, the
 * user pressed stop), or the process is shutting down. Both leave a `tool.call.started` with no
 * `tool.call.completed`, and a dashboard that only ever sees the pair would show the call as
 * still running for ever.
 *
 * The register is per `createMcp`, not per request, so `shutdown()` can close whatever is open
 * across every connection inside the SIGTERM budget (invariant 12).
 */
import type { XrayCorrelation, XrayEmitter } from '../contracts/index.js';

export interface InFlightCall {
  readonly tool: string;
  readonly startedAt: number;
  readonly correlation: XrayCorrelation;
}

export interface InFlightCalls {
  /** Returns the handle that ends the call; calling it twice is a no-op. */
  start(call: InFlightCall): () => void;
  cancel(handle: () => void, reason: 'client_cancelled' | 'timeout'): void;
  /** Cancels everything still open. Returns how many calls it closed. */
  cancelAll(reason: 'server_stopping'): number;
  readonly size: number;
}

export function createInFlightCalls(deps: {
  readonly xray: XrayEmitter;
  readonly now: () => Date;
}): InFlightCalls {
  const open = new Map<symbol, InFlightCall>();
  const handles = new Map<() => void, symbol>();

  function emitCancelled(
    call: InFlightCall,
    reason: 'client_cancelled' | 'timeout' | 'server_stopping',
  ): void {
    deps.xray.emit(
      'tool.call.cancelled',
      {
        tool: call.tool,
        duration_ms: Math.max(0, deps.now().getTime() - call.startedAt),
        reason,
      },
      call.correlation,
    );
  }

  return {
    get size() {
      return open.size;
    },

    start(call: InFlightCall): () => void {
      const key = Symbol('mcp.call');
      open.set(key, call);
      const finish = (): void => {
        open.delete(key);
        handles.delete(finish);
      };
      handles.set(finish, key);
      return finish;
    },

    cancel(handle: () => void, reason: 'client_cancelled' | 'timeout'): void {
      const key = handles.get(handle);
      if (key === undefined) return;
      const call = open.get(key);
      if (call !== undefined) emitCancelled(call, reason);
      handle();
    },

    cancelAll(reason: 'server_stopping'): number {
      const calls = [...open.values()];
      open.clear();
      handles.clear();
      for (const call of calls) emitCancelled(call, reason);
      return calls.length;
    },
  };
}

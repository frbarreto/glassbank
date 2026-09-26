/**
 * Test harness for `src/etl`.
 *
 * The block dependency rules (docs/REPO_LAYOUT.md section 3, enforced by `eslint.config.js` and
 * `test/import-boundaries.test.ts`) let `etl` import `src/contracts` and nothing else - not even
 * `src/testing/fakes.ts`. So the recording emitter lives here, exactly as `bank-core` does it. It
 * still validates every event against `XrayEventSchema`: an `etl.*` or `sql.*` event this block
 * cannot serialise would be a broken feature under CLAUDE.md invariant 13.
 */
import {
  XrayEventSchema,
  type XrayCorrelation,
  type XrayEmitter,
  type XrayEvent,
  type XrayEventDataInput,
  type XrayEventType,
} from '../../contracts/index.js';

export interface RecordingEmitter extends XrayEmitter {
  readonly events: XrayEvent[];
  ofType<T extends XrayEventType>(type: T): Extract<XrayEvent, { type: T }>[];
  lastOfType<T extends XrayEventType>(type: T): Extract<XrayEvent, { type: T }> | undefined;
  types(): string[];
  clear(): void;
}

export function createRecordingEmitter(now: () => Date = () => new Date()): RecordingEmitter {
  const events: XrayEvent[] = [];
  let nextId = 1;

  const emitter: RecordingEmitter = {
    events,
    emit<T extends XrayEventType>(
      type: T,
      data: XrayEventDataInput<T>,
      correlation?: XrayCorrelation,
    ): void {
      const candidate = {
        id: nextId,
        ts: now().toISOString(),
        v: 1,
        type,
        seq: null,
        ...correlation,
        data,
      };
      nextId += 1;
      // Throws on a malformed event: in a test that is exactly what we want to hear about.
      events.push(XrayEventSchema.parse(candidate));
    },
    ofType(type) {
      return events.filter(
        (event): event is Extract<XrayEvent, { type: typeof type }> => event.type === type,
      );
    },
    lastOfType(type) {
      return this.ofType(type).at(-1);
    },
    types() {
      return events.map((event) => event.type);
    },
    clear() {
      events.length = 0;
    },
  };
  return emitter;
}

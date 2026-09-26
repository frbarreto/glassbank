/**
 * Test harness for `src/bank-core`.
 *
 * The block dependency rules (docs/REPO_LAYOUT.md section 3, enforced by `eslint.config.js` and
 * `test/import-boundaries.test.ts`) let `bank-core` import `src/contracts` and nothing else - not
 * even `src/testing/fakes.ts`. So the recording emitter lives here. It still validates every event
 * against `XrayEventSchema`, which is the point: a `bank.op` this block cannot serialise would be
 * a broken feature under invariant 13, and the tests must fail on it.
 */
import {
  XrayEventSchema,
  type XrayCorrelation,
  type XrayEmitter,
  type XrayEvent,
  type XrayEventDataInput,
  type XrayEventType,
} from '../../contracts/index.js';
import { createBankCore, type BankCoreDeps, type BankCoreHandle } from '../index.js';

export interface RecordingEmitter extends XrayEmitter {
  readonly events: XrayEvent[];
  ofType<T extends XrayEventType>(type: T): Extract<XrayEvent, { type: T }>[];
  /** The `operation` of every `bank.op` recorded, in order. */
  operations(): string[];
  clear(): void;
}

export function createRecordingEmitter(now: () => Date): RecordingEmitter {
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
    operations() {
      return events
        .filter((event) => event.type === 'bank.op')
        .map((event) => (event.data as { operation: string }).operation);
    },
    clear() {
      events.length = 0;
    },
  };
  return emitter;
}

/** A clock the test moves by hand; `bank-core` never calls `new Date()` on its own. */
export interface TestClock {
  now(): Date;
  set(date: Date): void;
  advanceMinutes(minutes: number): void;
  advanceHours(hours: number): void;
}

/** Noon UTC, so a test can move a few hours without rolling the dataset's UTC day over. */
export const TEST_NOW = new Date('2026-09-08T12:00:00.000Z');

export function createTestClock(start: Date = TEST_NOW): TestClock {
  let current = new Date(start.getTime());
  return {
    now: () => new Date(current.getTime()),
    set: (date) => {
      current = new Date(date.getTime());
    },
    advanceMinutes: (minutes) => {
      current = new Date(current.getTime() + minutes * 60_000);
    },
    advanceHours: (hours) => {
      current = new Date(current.getTime() + hours * 3_600_000);
    },
  };
}

export interface Harness {
  readonly bank: BankCoreHandle;
  readonly emitter: RecordingEmitter;
  readonly clock: TestClock;
}

export function createHarness(
  options: Omit<BankCoreDeps, 'emitter' | 'now'> & { readonly start?: Date } = {},
): Harness {
  const { start, ...deps } = options;
  const clock = createTestClock(start);
  const emitter = createRecordingEmitter(() => clock.now());
  const bank = createBankCore({ ...deps, emitter, now: () => clock.now() });
  return { bank, emitter, clock };
}

/** The shared retail persona every test uses unless it needs something else. */
export const AVA = 'per_ava_stone';
export const NOAH = 'per_noah_reid';
export const HARBOR = 'per_harbor_supply';

export const LOGIN_A = 'lgn_alpha';
export const LOGIN_B = 'lgn_bravo';

export function scopeOf(personaId: string, loginId: string, grantId?: string) {
  return grantId === undefined
    ? { persona_id: personaId, login_id: loginId }
    : { persona_id: personaId, login_id: loginId, grant_id: grantId };
}

/** Walks every page of a list operation and returns the flat result plus the page count. */
export async function drain<T>(
  fetchPage: (cursor: string | null) => Promise<{
    data: readonly T[];
    page: { next: string | null };
  }>,
): Promise<{ rows: T[]; pages: number }> {
  const rows: T[] = [];
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    const page = await fetchPage(cursor);
    rows.push(...page.data);
    pages += 1;
    if (page.page.next === null) break;
    cursor = page.page.next;
    if (pages > 200) throw new Error('drain(): more than 200 pages, the cursor is not advancing');
  }
  return { rows, pages };
}

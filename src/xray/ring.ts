/**
 * The live fan-out ring buffer (block: xray).
 *
 * The last `RING_BUFFER_SIZE` (10,000) events, in memory, for the "now" strip and for a replay
 * that is still inside the window. Fixed-size array, no allocation per push, no timers: this is
 * on the hot path of every producer and must stay O(1) (docs/XRAY_EVENT_MODEL.md section 5).
 */
import { RING_BUFFER_SIZE, type XrayEvent } from '../contracts/index.js';

/**
 * Ceiling on the characters the ring holds, on top of the event count.
 *
 * A count alone is not a memory bound: even with the redaction pipeline's per-event budget, 10,000
 * events at 64 KB each is 640 MB on an instance that has 1 GiB for everything. Whichever bound
 * binds first evicts, so a stream of small events still gets the full 10,000-event history.
 */
export const RING_BYTES_BUDGET = 48_000_000;

/** Cheap size estimate: the envelope is only ever JSON, and this runs on the producer's path. */
function approximateBytes(event: XrayEvent): number {
  try {
    return JSON.stringify(event).length;
  } catch {
    return 1024;
  }
}

export interface Ring {
  push(event: XrayEvent): void;
  /** Every buffered event with `id > afterId`, oldest first, at most `limit`. */
  after(afterId: number, limit: number): XrayEvent[];
  /** The last `limit` events, oldest first. */
  last(limit: number): XrayEvent[];
  /** Lowest id still buffered, or `null` when the ring is empty. */
  readonly oldestId: number | null;
  readonly size: number;
  /** Approximate characters currently held; the second bound alongside `size`. */
  readonly bytes: number;
  clear(): void;
  /**
   * Drops every buffered event the predicate accepts and answers how many went (v0.4). Without
   * this an erased session would come straight back on the next `Last-Event-ID` replay.
   */
  remove(predicate: (event: XrayEvent) => boolean): number;
}

export function createRing(
  capacity: number = RING_BUFFER_SIZE,
  bytesBudget: number = RING_BYTES_BUDGET,
): Ring {
  if (capacity < 1) throw new Error('a ring buffer needs a capacity of at least 1');
  const slots: (XrayEvent | undefined)[] = new Array<XrayEvent | undefined>(capacity);
  const sizes: number[] = new Array<number>(capacity).fill(0);
  let next = 0;
  let count = 0;
  let bytes = 0;

  function snapshot(): XrayEvent[] {
    const events: XrayEvent[] = [];
    const start = count < capacity ? 0 : next;
    for (let offset = 0; offset < count; offset += 1) {
      const event = slots[(start + offset) % capacity];
      if (event) events.push(event);
    }
    return events;
  }

  function push(event: XrayEvent): void {
    const size = approximateBytes(event);
    // Overwriting a slot: the event that lived there stops counting.
    if (count === capacity) bytes -= sizes[next] ?? 0;
    slots[next] = event;
    sizes[next] = size;
    bytes += size;
    next = (next + 1) % capacity;
    if (count < capacity) count += 1;
    // Then drop the oldest until the byte budget is met again. The event just pushed is always
    // kept, however large it is, so `push` never silently loses the newest event.
    while (count > 1 && bytes > bytesBudget) {
      const oldest = (next - count + capacity) % capacity;
      bytes -= sizes[oldest] ?? 0;
      slots[oldest] = undefined;
      sizes[oldest] = 0;
      count -= 1;
    }
  }

  return {
    push,
    after(afterId, limit) {
      const events: XrayEvent[] = [];
      for (const event of snapshot()) {
        if (event.id > afterId) events.push(event);
        if (events.length >= limit) break;
      }
      return events;
    },
    last(limit) {
      const events = snapshot();
      return limit >= events.length ? events : events.slice(events.length - limit);
    },
    get oldestId() {
      if (count === 0) return null;
      const start = count < capacity ? 0 : next;
      return slots[start % capacity]?.id ?? null;
    },
    get size() {
      return count;
    },
    get bytes() {
      return bytes;
    },
    clear() {
      slots.fill(undefined);
      sizes.fill(0);
      next = 0;
      count = 0;
      bytes = 0;
    },
    remove(predicate) {
      const kept = snapshot().filter((event) => !predicate(event));
      const removed = count - kept.length;
      if (removed === 0) return 0;
      slots.fill(undefined);
      sizes.fill(0);
      next = 0;
      count = 0;
      bytes = 0;
      // Re-pushed in id order, so `oldestId` and `after()` stay correct.
      for (const event of kept) push(event);
      return removed;
    },
  };
}

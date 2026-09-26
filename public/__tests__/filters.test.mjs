/**
 * The filter language and the pairing-code input (block: dashboard).
 */
import { describe, expect, it } from 'vitest';
import {
  describeFilter,
  isEmptyFilter,
  matchesFilter,
  parseFilter,
  toggleToken,
} from '../filters.js';
import { codeFromUrl, isPairingCode, normalisePairingInput, pairingErrorText } from '../pairing.js';
import { backoffMs, parseJsonl, RECONNECT_MAX_MS } from '../stream.js';
import { detectBase, readQuery } from '../api.js';
import { duration, money, percentile, plural, ratio, seconds } from '../format.js';
import { loadFixture } from './helpers.mjs';

const events = loadFixture();
const matching = (raw) => events.filter((event) => matchesFilter(parseFilter(raw), event)).length;

describe('the filter language', () => {
  it('treats an empty filter as "show everything"', () => {
    expect(isEmptyFilter(parseFilter('   '))).toBe(true);
    expect(matching('')).toBe(events.length);
  });

  it('supports tool, type, kind, status and session tokens', () => {
    expect(matching('tool:execute_query')).toBe(19);
    expect(matching('type:tool.call.completed')).toBe(24);
    expect(matching('type:tool')).toBe(50);
    expect(matching('kind:sql')).toBe(9);
    expect(matching('status:error')).toBe(12);
    expect(matching('xs:xs_7b4d10')).toBe(28);
  });

  it('ANDs different keys and ORs values of the same key', () => {
    expect(matching('status:error kind:sql')).toBe(2);
    expect(matching('kind:sql kind:etl')).toBe(matching('kind:sql') + matching('kind:etl'));
  });

  it('negates with a leading dash', () => {
    expect(matching('-kind:http')).toBe(events.length - matching('kind:http'));
  });

  it('falls back to free text over a small haystack', () => {
    expect(matching('attach')).toBe(2);
    expect(matching('recursive')).toBeGreaterThan(0);
    expect(matching('no-such-string-anywhere')).toBe(0);
  });

  it('describes itself for the chip row and toggles cleanly', () => {
    expect(describeFilter(parseFilter('kind:sql status:error')).map((chip) => chip.label)).toEqual([
      'SQL',
      'status error',
    ]);
    expect(toggleToken('kind:tool', 'status:error')).toBe('kind:tool status:error');
    expect(toggleToken('kind:tool status:error', 'kind:tool')).toBe('status:error');
  });
});

describe('the pairing-code box', () => {
  it('regroups whatever the viewer pastes', () => {
    expect(normalisePairingInput('bank-7q2f-k3mz-8a')).toBe('BANK-7Q2F-K3MZ-8A');
    expect(normalisePairingInput('7q2fk3mz8a')).toBe('BANK-7Q2F-K3MZ-8A');
    expect(normalisePairingInput('bank 7q2f k3mz 8a')).toBe('BANK-7Q2F-K3MZ-8A');
    expect(normalisePairingInput('7Q2')).toBe('BANK-7Q2');
    expect(normalisePairingInput('')).toBe('');
  });

  it('drops the characters the alphabet excludes (0, O, 1, I)', () => {
    expect(normalisePairingInput('0O1I7Q2F')).toBe('BANK-7Q2F');
  });

  it('accepts a pasted pairing link', () => {
    expect(codeFromUrl('https://example.run.app/xray/s/BANK-7Q2F-K3MZ-8A')).toBe(
      'BANK-7Q2F-K3MZ-8A',
    );
    expect(codeFromUrl('nothing here')).toBeNull();
  });

  it('only calls a complete code valid', () => {
    expect(isPairingCode('BANK-7Q2F-K3MZ-8A')).toBe(true);
    expect(isPairingCode('BANK-7Q2F-K3MZ-8')).toBe(false);
    expect(isPairingCode('BANK-0Q2F-K3MZ-8A')).toBe(false);
  });

  it('has English for every rejection reason of the contract', () => {
    for (const reason of ['unknown_code', 'expired', 'rate_limited', 'malformed']) {
      expect(pairingErrorText(reason)).toMatch(/[a-z]/);
    }
    expect(pairingErrorText('something_new', 'server said so')).toBe('server said so');
  });
});

describe('the stream client', () => {
  it('backs off and never waits longer than the cap', () => {
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      const wait = backoffMs(attempt);
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(RECONNECT_MAX_MS);
    }
    expect(backoffMs(1)).toBeLessThan(backoffMs(5));
  });

  it('parses the fixture JSONL and skips blank lines', () => {
    expect(parseJsonl('')).toEqual([]);
    expect(parseJsonl('{"a":1}\n\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
    const bad = [];
    parseJsonl('{"a":1}\nnot json\n', (line) => bad.push(line));
    expect(bad).toEqual([2]);
  });

  it('detects the mount point so the same files work at /xray/ and at the root', () => {
    expect(detectBase('/xray/')).toBe('/xray');
    expect(detectBase('/xray')).toBe('/xray');
    expect(detectBase('/')).toBe('');
  });

  it('reads the fixture switches off the query string', () => {
    expect(readQuery('?fixture=1&rate=5&autoplay=all')).toEqual({
      fixture: true,
      autoplay: 'all',
      rate: 5,
      xs: null,
      all: false,
    });
  });
});

describe('formatting', () => {
  it('renders durations the way the panels quote them', () => {
    expect(duration(6)).toBe('6 ms');
    expect(duration(1240)).toBe('1.24 s');
    expect(duration(125_000)).toBe('2 m 05 s');
    expect(duration(null)).toBe('-');
    expect(seconds(300_000)).toBe('300 s');
  });

  it('clamps ratios and pluralises', () => {
    expect(ratio(6, 300_000)).toBeCloseTo(0.00002);
    expect(ratio(10, 0)).toBe(0);
    expect(ratio(-5, 10)).toBe(0);
    expect(ratio(50, 10)).toBe(1);
    expect(plural(1, 'live table')).toBe('1 live table');
    expect(plural(3, 'live table')).toBe('3 live tables');
    expect(plural(2, 'query', 'queries')).toBe('2 queries');
  });

  it('computes percentiles by nearest rank', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([], 50)).toBeNull();
  });
});

describe('money', () => {
  it('prints USD cents as dollars with thousands separators', () => {
    expect(money(123456)).toBe('$1,234.56');
    expect(money(0)).toBe('$0.00');
    expect(money(5)).toBe('$0.05');
    expect(money(100)).toBe('$1.00');
    expect(money(1042300, 'USD')).toBe('$10,423.00');
  });

  it('puts the minus in front of the sign for a negative amount', () => {
    expect(money(-284100)).toBe('-$2,841.00');
    expect(money(-1)).toBe('-$0.01');
  });

  it('shows the currency code only when it is not USD', () => {
    expect(money(123456, 'EUR')).toBe('1,234.56 EUR');
    expect(money(-50, 'gbp')).toBe('-0.50 GBP');
    expect(money(250, 'usd')).toBe('$2.50');
  });

  it('never prints NaN', () => {
    expect(money(null)).toBe('-');
    expect(money(undefined)).toBe('-');
    expect(money('twelve')).toBe('-');
  });
});

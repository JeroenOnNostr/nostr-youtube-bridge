import { describe, it, expect } from 'vitest';

import {
  JOB_SEARCH,
  JOB_SEARCH_RESULT,
  JOB_WATCH,
  JOB_WATCH_RESULT,
  JOB_STATUS,
  looksLikeChannelRef,
  clampBackfill,
  DVM_DEFAULTS,
} from './dvm';

describe('job kind constants (contract)', () => {
  it('match docs/dvm-contract.md', () => {
    expect(JOB_SEARCH).toBe(5392);
    expect(JOB_SEARCH_RESULT).toBe(6392);
    expect(JOB_WATCH).toBe(5393);
    expect(JOB_WATCH_RESULT).toBe(6393);
    expect(JOB_STATUS).toBe(7000);
  });
});

describe('looksLikeChannelRef', () => {
  it('treats UC ids, URLs and @handles as direct references', () => {
    expect(looksLikeChannelRef('UCabcdefghijklmnopqrstuv')).toBe(true);
    expect(looksLikeChannelRef('@veritasium')).toBe(true);
    expect(looksLikeChannelRef('https://www.youtube.com/@veritasium')).toBe(true);
    expect(looksLikeChannelRef('youtube.com/channel/UCabcdefghijklmnopqrstuv')).toBe(true);
    expect(looksLikeChannelRef('youtu.be/dQw4w9WgXcQ')).toBe(true);
  });

  it('treats free text as a search query', () => {
    expect(looksLikeChannelRef('veritasium')).toBe(false);
    expect(looksLikeChannelRef('science explainers')).toBe(false);
  });
});

describe('clampBackfill', () => {
  it('defaults to 20 when absent or non-numeric', () => {
    expect(clampBackfill(undefined)).toBe(DVM_DEFAULTS.DEFAULT_BACKFILL_LONG);
    expect(clampBackfill('')).toBe(DVM_DEFAULTS.DEFAULT_BACKFILL_LONG);
    expect(clampBackfill('abc')).toBe(DVM_DEFAULTS.DEFAULT_BACKFILL_LONG);
    expect(clampBackfill('0')).toBe(DVM_DEFAULTS.DEFAULT_BACKFILL_LONG);
  });

  it('passes through a sane value and caps at the max', () => {
    expect(clampBackfill('10')).toBe(10);
    expect(clampBackfill('20')).toBe(20);
    expect(clampBackfill('9999')).toBe(DVM_DEFAULTS.MAX_BACKFILL_LONG);
  });
});

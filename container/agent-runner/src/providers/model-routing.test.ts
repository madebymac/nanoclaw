import { describe, expect, it } from 'bun:test';
import { resolveAutoModel } from './model-routing.js';

const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-4-6';

describe('resolveAutoModel', () => {
  it('returns Haiku for a short greeting', () => {
    expect(resolveAutoModel('Hello, how are you?')).toBe(HAIKU);
  });

  it('returns Haiku for a short conversational question', () => {
    expect(resolveAutoModel('What time is it in Tokyo?')).toBe(HAIKU);
  });

  it('returns Sonnet for the "review" keyword', () => {
    expect(resolveAutoModel('Can you review this code?')).toBe(SONNET);
  });

  it('returns Sonnet for the "implement" keyword', () => {
    expect(resolveAutoModel('Implement a rate limiter')).toBe(SONNET);
  });

  it('returns Sonnet for prompts longer than 400 chars', () => {
    expect(resolveAutoModel('a'.repeat(401))).toBe(SONNET);
  });

  it('returns Sonnet for prompts at exactly 400 chars with no complex keyword', () => {
    expect(resolveAutoModel('a'.repeat(400))).toBe(SONNET);
  });

  it('returns Haiku for a short prompt with no complex keywords', () => {
    expect(resolveAutoModel('What is 2 + 2?')).toBe(HAIKU);
  });

  it('returns Sonnet for "debug" keyword regardless of length', () => {
    expect(resolveAutoModel('debug this')).toBe(SONNET);
  });

  it('returns Sonnet for "analyze" (stem analyz + word char)', () => {
    expect(resolveAutoModel('analyze this')).toBe(SONNET);
  });

  it('returns Sonnet for "create" (stem creat + word char)', () => {
    expect(resolveAutoModel('create a function')).toBe(SONNET);
  });

  it('returns Sonnet for "migrate" (stem migrat + word char)', () => {
    expect(resolveAutoModel('migrate the database')).toBe(SONNET);
  });

  it('returns Sonnet for "optimize" (stem optimiz + word char)', () => {
    expect(resolveAutoModel('optimize this query')).toBe(SONNET);
  });

  it('returns Sonnet for "generate" (stem generat + word char)', () => {
    expect(resolveAutoModel('generate a report')).toBe(SONNET);
  });
});

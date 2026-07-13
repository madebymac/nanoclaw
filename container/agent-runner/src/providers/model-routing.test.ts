import { describe, expect, it } from 'bun:test';
import { resolveAutoModel } from './model-routing.js';

const SONNET = 'claude-sonnet-4-6';
const OPUS = 'claude-opus-4-7';

describe('resolveAutoModel', () => {
  it('returns Sonnet for a short greeting', () => {
    expect(resolveAutoModel('Hello, how are you?')).toBe(SONNET);
  });

  it('returns Sonnet for a short conversational question', () => {
    expect(resolveAutoModel('What time is it in Tokyo?')).toBe(SONNET);
  });

  it('returns Opus for the "review" keyword', () => {
    expect(resolveAutoModel('Can you review this code?')).toBe(OPUS);
  });

  it('returns Opus for the "implement" keyword', () => {
    expect(resolveAutoModel('Implement a rate limiter')).toBe(OPUS);
  });

  it('returns Opus for prompts longer than 400 chars', () => {
    expect(resolveAutoModel('a'.repeat(401))).toBe(OPUS);
  });

  it('returns Opus for prompts at exactly 400 chars with no complex keyword', () => {
    expect(resolveAutoModel('a'.repeat(400))).toBe(OPUS);
  });

  it('returns Sonnet for a short prompt with no complex keywords', () => {
    expect(resolveAutoModel('What is 2 + 2?')).toBe(SONNET);
  });

  it('returns Opus for "debug" keyword regardless of length', () => {
    expect(resolveAutoModel('debug this')).toBe(OPUS);
  });

  it('returns Opus for "analyze" (stem analyz + word char)', () => {
    expect(resolveAutoModel('analyze this')).toBe(OPUS);
  });

  it('returns Opus for "create" (stem creat + word char)', () => {
    expect(resolveAutoModel('create a function')).toBe(OPUS);
  });

  it('returns Opus for "migrate" (stem migrat + word char)', () => {
    expect(resolveAutoModel('migrate the database')).toBe(OPUS);
  });

  it('returns Opus for "optimize" (stem optimiz + word char)', () => {
    expect(resolveAutoModel('optimize this query')).toBe(OPUS);
  });

  it('returns Opus for "generate" (stem generat + word char)', () => {
    expect(resolveAutoModel('generate a report')).toBe(OPUS);
  });

  it('returns Opus for "write" keyword', () => {
    expect(resolveAutoModel('write a function')).toBe(OPUS);
  });

  it('returns Opus for "code" keyword', () => {
    expect(resolveAutoModel('code this up')).toBe(OPUS);
  });

  it('returns Opus for "fix" keyword', () => {
    expect(resolveAutoModel('fix the bug')).toBe(OPUS);
  });
});

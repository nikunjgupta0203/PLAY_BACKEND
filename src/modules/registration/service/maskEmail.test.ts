import { describe, expect, it } from 'vitest';
import { maskEmail } from './maskEmail.js';

describe('maskEmail', () => {
  it('keeps the first character of the local part and the whole domain', () => {
    expect(maskEmail('alice@example.com')).toBe('a•••@example.com');
  });

  it('a one-character local part still keeps that one character', () => {
    expect(maskEmail('a@example.com')).toBe('a•••@example.com');
  });

  it('does not touch the domain, including subdomains and casing', () => {
    expect(maskEmail('Bob@Mail.Example.Co.IN')).toBe('B•••@Mail.Example.Co.IN');
  });

  it('a string with no @ is returned unchanged rather than throwing', () => {
    expect(maskEmail('not-an-email')).toBe('not-an-email');
  });
});

import { describe, expect, it } from 'vitest';
import { checkAccountNumber, checkIfsc, checkPan, last4, normaliseUpper, panMatchesSurname } from './pan.js';

describe('payouts R4 — PAN', () => {
  it.each([
    ['ABCPS1234K', 'ok'],
    ['ABCPS12345', 'INVALID_PAN'],
    ['ABCP1234K', 'INVALID_PAN'],
    ['ABCCS1234K', 'PAN_NOT_INDIVIDUAL'],
    ['ABCFS1234K', 'PAN_NOT_INDIVIDUAL'],
    ['ABCHS1234K', 'PAN_NOT_INDIVIDUAL'],
  ] as const)('%s → %s', (pan, expected) => {
    expect(checkPan(pan)).toBe(expected);
  });

  it('normalises lower case and spaces before checking', () => {
    expect(normaliseUpper('  abcps 1234k ')).toBe('ABCPS1234K');
    expect(checkPan(normaliseUpper('abcps1234k'))).toBe('ok');
  });

  it.each([
    ['ABCPS1234K', 'Rahul Sharma', true],
    ['ABCPK1234K', 'Rahul Sharma', false],
    ['ABCPK1234K', 'S. Ramesh Kumar', true],
    ['ABCPR1234K', 'Ramesh', true],
    ['ABCPS1234K', '  rahul   sharma  ', true],
    ['ABCPS1234K', '', false],
  ] as const)('%s with "%s" → surname match %s', (pan, name, expected) => {
    expect(panMatchesSurname(pan, name)).toBe(expected);
  });
});

describe('payouts R1 — bank details', () => {
  it('checks IFSC', () => {
    expect(checkIfsc('HDFC0001098')).toBe(true);
    expect(checkIfsc(normaliseUpper(' hdfc0001098 '))).toBe(true);
    expect(checkIfsc('HDFC1001098')).toBe(false);
    expect(checkIfsc('HDF0001098')).toBe(false);
  });

  it('checks the account number is 9–18 digits', () => {
    expect(checkAccountNumber('51234567890')).toBe(true);
    expect(checkAccountNumber('12345678')).toBe(false);
    expect(checkAccountNumber('1234567890123456789')).toBe(false);
    expect(checkAccountNumber('5123 4567 890')).toBe(false);
  });

  it('keeps the last four for masks', () => {
    expect(last4('51234567890')).toBe('7890');
  });
});

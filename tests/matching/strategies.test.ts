import { describe, expect, it } from 'vitest';
import { parseCalendarDate } from '../../src/dates';
import {
  labelNamesSupplier,
  referenceStrategy,
  supplierNameStrategy,
  uniqueAmountDateStrategy,
} from '../../src/matching/strategies';
import type { Invoice, Transaction } from '../../src/matching/types';

const transaction = (overrides: Partial<Transaction> = {}): Transaction => ({
  id: 't1',
  amountCents: -4499,
  label: 'PRLV SEPA BOUYGUES TELECOM',
  reference: '',
  date: parseCalendarDate('2026-04-09'),
  ...overrides,
});

const inv = (id: string, overrides: Partial<Invoice> = {}): Invoice => ({
  id,
  supplierName: 'Bouygues Telecom',
  invoiceNumber: `F-${id}`,
  totalCents: 4499,
  dueDate: parseCalendarDate('2026-04-10'),
  ...overrides,
});

describe('referenceStrategy', () => {
  it('passes when the transaction has no reference', () => {
    expect(referenceStrategy.decide(transaction(), [inv('a')])).toEqual({ kind: 'pass' });
  });

  it('matches the candidate the reference names, ignoring case and spaces', () => {
    const target = inv('b');
    const result = referenceStrategy.decide(transaction({ reference: ' f-b ' }), [inv('a'), target]);
    expect(result).toEqual({ kind: 'match', invoice: target });
  });

  it('vetoes when the reference names an invoice that is not a candidate', () => {
    const result = referenceStrategy.decide(transaction({ reference: 'F-OTHER' }), [inv('a')]);
    expect(result).toMatchObject({ kind: 'reject', reason: 'reference_mismatch' });
  });

  it('never matches an invoice with an empty number', () => {
    const result = referenceStrategy.decide(transaction({ reference: 'F-X' }), [
      inv('a', { invoiceNumber: '' }),
    ]);
    expect(result).toMatchObject({ kind: 'reject', reason: 'reference_mismatch' });
  });

  it('refuses to choose between two invoices with the same number', () => {
    const result = referenceStrategy.decide(transaction({ reference: 'DUP' }), [
      inv('a', { invoiceNumber: 'DUP' }),
      inv('b', { invoiceNumber: 'DUP' }),
    ]);
    expect(result).toMatchObject({ kind: 'reject', reason: 'ambiguous' });
  });
});

describe('uniqueAmountDateStrategy', () => {
  it('matches a single candidate', () => {
    const only = inv('a');
    expect(uniqueAmountDateStrategy.decide(transaction(), [only])).toEqual({ kind: 'match', invoice: only });
  });

  it('passes on several candidates', () => {
    expect(uniqueAmountDateStrategy.decide(transaction(), [inv('a'), inv('b')])).toEqual({ kind: 'pass' });
  });
});

describe('supplierNameStrategy', () => {
  it('picks the only candidate whose supplier the label names', () => {
    const elis = inv('elis', { supplierName: 'Elis' });
    const result = supplierNameStrategy.decide(transaction({ label: 'PRLV SEPA ELIS SERVICES' }), [
      inv('a', { supplierName: 'Orange' }),
      elis,
    ]);
    expect(result).toEqual({ kind: 'match', invoice: elis });
  });

  it('stays out of it when two candidates share the supplier (recurring bills)', () => {
    expect(supplierNameStrategy.decide(transaction(), [inv('a'), inv('b')])).toEqual({ kind: 'pass' });
  });
});

describe('labelNamesSupplier', () => {
  it.each([
    ['PRLV SEPA ELIS SERVICES', 'Elis', true],
    ['CB ÉLIS', 'Elis', true],
    ['VIR ELISABETH DUPONT', 'Elis', false], // substring, not a word
    ['CB METRO PARIS NANTERRE', 'Metro Cash & Carry', false], // not every word present
    ['ANYTHING', '', false],
    ['ANYTHING', 'SA', false], // no significant word
  ])('%s names %s → %s', (label, supplier, expected) => {
    expect(labelNamesSupplier(label, supplier)).toBe(expected);
  });
});

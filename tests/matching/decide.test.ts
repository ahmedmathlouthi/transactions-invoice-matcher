import { describe, expect, it } from 'vitest';
import { decide } from '../../src/matching/decide';
import { invoice, tx } from '../fixtures';

const only = (result: ReturnType<typeof decide>) => {
  expect(result.decisions).toHaveLength(1);
  return result.decisions[0];
};

describe('decide', () => {
  it('matches the single invoice with the same amount and a due date in the window', () => {
    const target = invoice();
    expect(only(decide([tx()], [target]))).toMatchObject({
      outcome: 'matched',
      invoiceId: target.id,
      strategy: 'unique_amount_date',
    });
  });

  describe('date window: due date from 3 days before to 30 days after the payment', () => {
    it.each([
      ['2026-04-06', 'matched'], // -3
      ['2026-04-05', 'no_candidate'], // -4
      ['2026-05-09', 'matched'], // +30
      ['2026-05-10', 'no_candidate'], // +31
    ])('due %s → %s', (dueDate, outcome) => {
      expect(only(decide([tx({ date: '2026-04-09' })], [invoice({ dueDate })])).outcome).toBe(outcome);
    });
  });

  it('compares amounts in cents, so float sums still match (finding 6)', () => {
    expect(1.74 + 0.54).not.toBe(2.28); // 2.2800000000000002
    const target = invoice({ taxFreeTotal: '1.74', vatAmount: '0.54' });
    expect(only(decide([tx({ amount: '-2.28' })], [target])).outcome).toBe('matched');
  });

  it('abstains on recurring bills with the same amount (finding 4)', () => {
    const decision = only(
      decide([tx({ date: '2026-04-09' })], [invoice({ dueDate: '2026-04-08' }), invoice({ dueDate: '2026-04-20' })]),
    );
    expect(decision.outcome).toBe('ambiguous');
  });

  it('uses the bank reference to pick among look-alikes', () => {
    const named = invoice({ invoiceNumber: 'F-2026-00267' });
    const decision = only(decide([tx({ reference: 'F-2026-00267' })], [invoice(), named]));
    expect(decision).toMatchObject({ outcome: 'matched', invoiceId: named.id, strategy: 'reference' });
  });

  it('refuses a match when the reference names a different invoice (finding 5)', () => {
    const decision = only(decide([tx({ reference: 'F-2026-00001' })], [invoice({ invoiceNumber: 'F-2026-09999' })]));
    expect(decision.outcome).toBe('reference_mismatch');
  });

  it('gives no advantage to an invoice with an empty number (finding 5)', () => {
    const decision = only(decide([tx()], [invoice({ invoiceNumber: '' }), invoice()]));
    expect(decision.outcome).toBe('ambiguous');
  });

  it('does not crash on a NULL supplier name, and still matches (finding 10)', () => {
    const decision = only(decide([tx()], [invoice({ supplierName: null })]));
    expect(decision.outcome).toBe('matched');
  });

  it('flags duplicated bank-feed rows instead of matching them (finding 3)', () => {
    const decision = only(decide([tx({ feedCopies: 2 })], [invoice()]));
    expect(decision.outcome).toBe('duplicate_feed_row');
  });

  it('leaves both transactions unmatched when they claim the same invoice', () => {
    const { decisions } = decide([tx(), tx()], [invoice()]);
    expect(decisions.map((d) => d.outcome)).toEqual(['conflict', 'conflict']);
  });

  it('turns a bad transaction into invalid_data without stopping the others', () => {
    const { decisions } = decide([tx({ amount: 'oops' }), tx({ date: null }), tx()], [invoice()]);
    expect(decisions.map((d) => d.outcome)).toEqual(['invalid_data', 'invalid_data', 'matched']);
  });

  it('refuses incoming money even if it slips past the query (finding 2)', () => {
    expect(only(decide([tx({ amount: '44.99' })], [invoice()])).outcome).toBe('not_outgoing');
  });

  it('reports invoices it could not consider (finding 8)', () => {
    const { skippedInvoices } = decide([], [invoice({ dueDate: null }), invoice({ vatAmount: 'x' })]);
    expect(skippedInvoices.map((s) => s.reason)).toEqual(['no_due_date', 'invalid_data']);
  });
});

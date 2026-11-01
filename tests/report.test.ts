import { describe, expect, it } from 'vitest';
import { decide } from '../src/matching/decide';
import { buildReviewReport, REVIEW_COLUMNS, toCsv, type ReviewRow } from '../src/report';
import { invoice, tx } from './fixtures';

function reviewFor(transactions = [tx()], invoices = [invoice()]) {
  const { decisions } = decide(transactions, invoices);
  return buildReviewReport({ transactions, invoices, decisions });
}

describe('buildReviewReport', () => {
  it('lists each candidate invoice of an ambiguous transaction on its own row', () => {
    const payment = tx({ remoteId: 'BNK-1', date: '2026-04-09' });
    const later = invoice({ invoiceNumber: 'F-B', dueDate: '2026-04-20' });
    const earlier = invoice({ invoiceNumber: 'F-A', dueDate: '2026-04-08' });
    const rows = reviewFor([payment], [later, earlier]);

    expect(rows).toEqual([
      expect.objectContaining({
        transaction_id: payment.id,
        remote_id: 'BNK-1',
        amount: '-44.99',
        label: 'PRLV SEPA BOUYGUES TELECOM',
        candidate_count: '2',
        candidate: '1/2',
        invoice_number: 'F-A',
        invoice_id: earlier.id,
        invoice_due_date: '2026-04-08',
        days_due_after_payment: '-1',
        finance_choice: '',
      }),
      expect.objectContaining({
        transaction_id: payment.id,
        candidate: '2/2',
        invoice_number: 'F-B',
        days_due_after_payment: '11',
      }),
    ]);
  });

  it('leaves out matched, unmatched and invalid transactions', () => {
    const rows = reviewFor(
      [
        tx(), // matched: one candidate
        tx({ amount: '-999.00' }), // no candidate
        tx({ amount: 'oops' }), // invalid data
      ],
      [invoice()],
    );
    expect(rows).toEqual([]);
  });

  it('puts the oldest payments first', () => {
    const april = tx({ date: '2026-04-09' });
    const march = tx({ date: '2026-03-09' });
    const rows = reviewFor(
      [april, march],
      [
        invoice({ dueDate: '2026-04-10' }),
        invoice({ dueDate: '2026-04-11' }),
        invoice({ dueDate: '2026-03-10' }),
        invoice({ dueDate: '2026-03-11' }),
      ],
    );
    expect([...new Set(rows.map((r) => r.transaction_id))]).toEqual([march.id, april.id]);
  });
});

describe('toCsv', () => {
  it('quotes commas, quotes and newlines', () => {
    const csv = toCsv(['a', 'b'] as const, [{ a: 'x,y', b: 'say "hi"\nbye' }]);
    expect(csv).toBe('a,b\r\n"x,y","say ""hi""\nbye"\r\n');
  });

  it('neutralises spreadsheet formulas in bank text but keeps negative amounts', () => {
    const row = Object.fromEntries(REVIEW_COLUMNS.map((c) => [c, ''])) as ReviewRow;
    row.label = '=HYPERLINK("http://evil")';
    row.amount = '-44.99';
    row.days_due_after_payment = '-3';
    const [, line] = toCsv(REVIEW_COLUMNS, [row]).split('\r\n');
    expect(line).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(line).toContain(',-44.99,');
    expect(line).toContain(',-3,');
  });
});

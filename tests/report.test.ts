import { describe, expect, it } from 'vitest';
import { decide } from '../src/matching/decide';
import { buildReport, toCsv, TRANSACTION_COLUMNS } from '../src/report';
import { invoice, tx } from './fixtures';

function reportFor(transactions = [tx()], invoices = [invoice()]) {
  const { decisions, skippedInvoices } = decide(transactions, invoices);
  return buildReport({ transactions, invoices, decisions, skippedInvoices });
}

describe('buildReport', () => {
  it('describes a match with its invoice and strategy', () => {
    const target = invoice({ invoiceNumber: 'F-1', supplierName: 'Bouygues Telecom' });
    const [row] = reportFor([tx()], [target]).transactions;
    expect(row).toMatchObject({
      flag: 'MATCHED',
      outcome: 'matched',
      strategy: 'unique_amount_date',
      invoice_id: target.id,
      invoice_number: 'F-1',
      supplier: 'Bouygues Telecom',
    });
  });

  it('puts problems first, then review, then unmatched, then matched', () => {
    const rows = reportFor(
      [
        tx({ amount: '-999.00' }), // no candidate
        tx(), // matched
        tx({ amount: 'oops' }), // invalid
        tx({ amount: '-12.00' }), // ambiguous
      ],
      [invoice(), invoice({ taxFreeTotal: '10.00', vatAmount: '2.00' }), invoice({ taxFreeTotal: '10.00', vatAmount: '2.00' })],
    ).transactions;
    expect(rows.map((r) => r.flag)).toEqual(['PROBLEM', 'REVIEW', 'UNMATCHED', 'MATCHED']);
  });

  it('flags duplicated bank rows as problems, side by side', () => {
    const rows = reportFor(
      [
        tx({ remoteId: 'BNK-2', feedCopies: 2, date: '2026-04-01' }),
        tx({ remoteId: 'BNK-1', feedCopies: 1 }),
        tx({ remoteId: 'BNK-2', feedCopies: 2, date: '2026-04-01' }),
      ],
      [invoice()],
    ).transactions;
    expect(rows.slice(0, 2).map((r) => [r.flag, r.outcome, r.remote_id])).toEqual([
      ['PROBLEM', 'duplicate_feed_row', 'BNK-2'],
      ['PROBLEM', 'duplicate_feed_row', 'BNK-2'],
    ]);
  });

  it('lists the candidate invoices of an ambiguous transaction', () => {
    const [row] = reportFor(
      [tx()],
      [invoice({ invoiceNumber: 'F-A', dueDate: '2026-04-08' }), invoice({ invoiceNumber: 'F-B', dueDate: '2026-04-20' })],
    ).transactions;
    expect(row.flag).toBe('REVIEW');
    expect(row.candidate_invoices).toBe('F-A Bouygues Telecom due 2026-04-08 | F-B Bouygues Telecom due 2026-04-20');
  });

  it('lists skipped invoices with their reason', () => {
    const skipped = invoice({ dueDate: null, invoiceNumber: 'F-NODATE' });
    expect(reportFor([], [skipped]).skippedInvoices).toEqual([
      expect.objectContaining({ reason: 'no_due_date', invoice_id: skipped.id, invoice_number: 'F-NODATE' }),
    ]);
  });
});

describe('toCsv', () => {
  it('quotes commas, quotes and newlines', () => {
    const csv = toCsv(['a', 'b'] as const, [{ a: 'x,y', b: 'say "hi"\nbye' }]);
    expect(csv).toBe('a,b\r\n"x,y","say ""hi""\nbye"\r\n');
  });

  it('neutralises spreadsheet formulas in bank text but keeps negative amounts', () => {
    const row = Object.fromEntries(TRANSACTION_COLUMNS.map((c) => [c, ''])) as Record<
      (typeof TRANSACTION_COLUMNS)[number],
      string
    >;
    row.label = '=HYPERLINK("http://evil")';
    row.amount = '-44.99';
    const [, line] = toCsv(TRANSACTION_COLUMNS, [row]).split('\r\n');
    expect(line).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(line).toContain(',-44.99,');
  });
});

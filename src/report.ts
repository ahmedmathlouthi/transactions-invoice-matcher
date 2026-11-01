import { daysBetween, parseCalendarDate } from './dates';
import type { Decision, InvoiceRecord, TransactionRecord } from './matching/types';

/**
 * The review sheet for the finance team: every transaction the job refused to
 * match because several invoices fit equally well.
 *
 * One row per (transaction, candidate invoice), so the sheet can be filtered
 * and sorted in a spreadsheet. The transaction columns are repeated on each of
 * its rows on purpose. Finance marks the right invoice in `finance_choice`.
 */
export const REVIEW_COLUMNS = [
  'transaction_id',
  'remote_id',
  'transaction_date',
  'amount',
  'label',
  'reference',
  'candidate_count',
  'candidate',
  'invoice_number',
  'supplier',
  'invoice_due_date',
  'days_due_after_payment',
  'invoice_id',
  'finance_choice',
] as const;

export type ReviewRow = Record<(typeof REVIEW_COLUMNS)[number], string>;

function daysDueAfterPayment(transactionDate: string | null, dueDate: string | null): string {
  try {
    return String(daysBetween(parseCalendarDate(transactionDate), parseCalendarDate(dueDate)));
  } catch {
    return '';
  }
}

export function buildReviewReport(input: {
  transactions: readonly TransactionRecord[];
  invoices: readonly InvoiceRecord[];
  decisions: readonly Decision[];
}): ReviewRow[] {
  const transactionsById = new Map(input.transactions.map((t) => [t.id, t]));
  const invoicesById = new Map(input.invoices.map((i) => [i.id, i]));

  const groups = input.decisions.flatMap((decision) => {
    if (decision.outcome !== 'ambiguous') return [];
    const tx = transactionsById.get(decision.transactionId);
    const candidates = (decision.candidateInvoiceIds ?? [])
      .map((id) => invoicesById.get(id))
      .filter((invoice): invoice is InvoiceRecord => invoice !== undefined);
    if (!tx || candidates.length < 2) return [];
    // Closest due date first, then a stable order.
    candidates.sort(
      (a, b) =>
        (a.dueDate ?? '').localeCompare(b.dueDate ?? '') ||
        (a.invoiceNumber ?? '').localeCompare(b.invoiceNumber ?? '') ||
        a.id.localeCompare(b.id),
    );
    return [{ tx, candidates }];
  });

  // Oldest payments first: those are the ones finance should clear first.
  groups.sort(
    (a, b) =>
      (a.tx.date ?? '').localeCompare(b.tx.date ?? '') ||
      (a.tx.remoteId ?? '').localeCompare(b.tx.remoteId ?? '') ||
      a.tx.id.localeCompare(b.tx.id),
  );

  return groups.flatMap(({ tx, candidates }) =>
    candidates.map(
      (invoice, index): ReviewRow => ({
        transaction_id: tx.id,
        remote_id: tx.remoteId ?? '',
        transaction_date: tx.date ?? '',
        amount: tx.amount,
        label: tx.label ?? '',
        reference: tx.reference ?? '',
        candidate_count: String(candidates.length),
        candidate: `${index + 1}/${candidates.length}`,
        invoice_number: invoice.invoiceNumber ?? '',
        supplier: invoice.supplierName ?? '',
        invoice_due_date: invoice.dueDate ?? '',
        days_due_after_payment: daysDueAfterPayment(tx.date, invoice.dueDate),
        invoice_id: invoice.id,
        finance_choice: '',
      }),
    ),
  );
}

/** Columns holding bank or supplier text, which may come from outside. */
const FREE_TEXT = new Set(['label', 'reference', 'supplier', 'invoice_number']);

function escapeCell(column: string, value: string): string {
  // A spreadsheet treats a cell starting with = + - @ as a formula. Bank labels
  // are external input, so neutralise that in text columns (amounts keep their sign).
  const safe = FREE_TEXT.has(column) && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** RFC 4180 CSV with a header row. */
export function toCsv<C extends string>(columns: readonly C[], rows: readonly Record<C, string>[]): string {
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => escapeCell(column, row[column])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

import type { Decision, InvoiceRecord, Outcome, SkippedInvoice, TransactionRecord } from './matching/types';

/**
 * How urgently a human should look at a row. Sorted in this order in the CSV,
 * so problems and duplicates are at the top.
 */
export type Flag = 'PROBLEM' | 'REVIEW' | 'UNMATCHED' | 'MATCHED';

const FLAG_ORDER: Record<Flag, number> = { PROBLEM: 0, REVIEW: 1, UNMATCHED: 2, MATCHED: 3 };

const FLAG_BY_OUTCOME: Record<Outcome, Flag> = {
  duplicate_feed_row: 'PROBLEM',
  conflict: 'PROBLEM',
  invalid_data: 'PROBLEM',
  not_outgoing: 'PROBLEM',
  ambiguous: 'REVIEW',
  reference_mismatch: 'REVIEW',
  no_candidate: 'UNMATCHED',
  matched: 'MATCHED',
};

export const TRANSACTION_COLUMNS = [
  'flag',
  'outcome',
  'transaction_id',
  'remote_id',
  'date',
  'amount',
  'label',
  'reference',
  'strategy',
  'invoice_id',
  'invoice_number',
  'supplier',
  'invoice_due_date',
  'candidate_invoices',
  'detail',
] as const;

export type TransactionReportRow = Record<(typeof TRANSACTION_COLUMNS)[number], string>;

export const SKIPPED_INVOICE_COLUMNS = [
  'reason',
  'invoice_id',
  'invoice_number',
  'supplier',
  'tax_free_total',
  'vat_amount',
  'due_date',
  'detail',
] as const;

export type SkippedInvoiceReportRow = Record<(typeof SKIPPED_INVOICE_COLUMNS)[number], string>;

export type Report = {
  transactions: TransactionReportRow[];
  skippedInvoices: SkippedInvoiceReportRow[];
};

const describeInvoice = (invoice: InvoiceRecord | undefined) =>
  invoice ? `${invoice.invoiceNumber || '(no number)'} ${invoice.supplierName ?? '(no supplier)'} due ${invoice.dueDate ?? '?'}` : '';

export function buildReport(input: {
  transactions: readonly TransactionRecord[];
  invoices: readonly InvoiceRecord[];
  decisions: readonly Decision[];
  skippedInvoices: readonly SkippedInvoice[];
}): Report {
  const transactionsById = new Map(input.transactions.map((t) => [t.id, t]));
  const invoicesById = new Map(input.invoices.map((i) => [i.id, i]));

  const transactions = input.decisions.map((decision): TransactionReportRow => {
    const tx = transactionsById.get(decision.transactionId);
    const outcome = decision.outcome;
    const invoice = decision.outcome === 'matched' ? invoicesById.get(decision.invoiceId) : undefined;
    const candidates =
      decision.outcome === 'matched' ? [] : (decision.candidateInvoiceIds ?? []).map((id) => invoicesById.get(id));

    return {
      flag: FLAG_BY_OUTCOME[outcome],
      outcome,
      transaction_id: decision.transactionId,
      remote_id: tx?.remoteId ?? '',
      date: tx?.date ?? '',
      amount: tx?.amount ?? '',
      label: tx?.label ?? '',
      reference: tx?.reference ?? '',
      strategy: decision.outcome === 'matched' ? decision.strategy : '',
      invoice_id: invoice?.id ?? '',
      invoice_number: invoice?.invoiceNumber ?? '',
      supplier: invoice?.supplierName ?? '',
      invoice_due_date: invoice?.dueDate ?? '',
      candidate_invoices: candidates.map(describeInvoice).filter(Boolean).join(' | '),
      detail: decision.outcome === 'matched' ? '' : (decision.detail ?? ''),
    };
  });

  // Problems first; within a flag, group by outcome, then put copies of the
  // same bank row next to each other.
  transactions.sort(
    (a, b) =>
      FLAG_ORDER[a.flag as Flag] - FLAG_ORDER[b.flag as Flag] ||
      a.outcome.localeCompare(b.outcome) ||
      a.remote_id.localeCompare(b.remote_id) ||
      a.date.localeCompare(b.date) ||
      a.transaction_id.localeCompare(b.transaction_id),
  );

  const skippedInvoices = input.skippedInvoices.map((skipped): SkippedInvoiceReportRow => {
    const invoice = invoicesById.get(skipped.invoiceId);
    return {
      reason: skipped.reason,
      invoice_id: skipped.invoiceId,
      invoice_number: invoice?.invoiceNumber ?? '',
      supplier: invoice?.supplierName ?? '',
      tax_free_total: invoice?.taxFreeTotal ?? '',
      vat_amount: invoice?.vatAmount ?? '',
      due_date: invoice?.dueDate ?? '',
      detail: skipped.detail ?? '',
    };
  });
  skippedInvoices.sort((a, b) => a.reason.localeCompare(b.reason) || a.invoice_id.localeCompare(b.invoice_id));

  return { transactions, skippedInvoices };
}

/** Columns holding bank or supplier text, which may come from outside. */
const FREE_TEXT = new Set(['label', 'reference', 'supplier', 'invoice_number', 'candidate_invoices', 'detail']);

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

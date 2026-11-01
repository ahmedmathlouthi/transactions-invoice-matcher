import { daysBetween, parseCalendarDate } from '../dates';
import { InvalidDataError } from '../errors';
import { parseCents, type Cents } from '../money';
import { DEFAULT_STRATEGIES } from './strategies';
import type {
  Decision,
  Invoice,
  InvoiceRecord,
  MatchingConfig,
  SkippedInvoice,
  Transaction,
  TransactionRecord,
} from './types';

export const DEFAULT_CONFIG: MatchingConfig = {
  windowDaysBefore: 3,
  windowDaysAfter: 30,
  strategies: DEFAULT_STRATEGIES,
};

export type DecideResult = {
  decisions: Decision[];
  skippedInvoices: SkippedInvoice[];
};

/** Type conversion only: no business rule here. */
function parseTransaction(record: TransactionRecord): Transaction {
  return {
    id: record.id,
    amountCents: parseCents(record.amount),
    label: record.label ?? '',
    reference: record.reference ?? '',
    date: parseCalendarDate(record.date),
  };
}

function parseInvoices(records: readonly InvoiceRecord[]) {
  const byTotal = new Map<Cents, Invoice[]>();
  const skipped: SkippedInvoice[] = [];

  for (const record of records) {
    if (record.dueDate === null) {
      skipped.push({ invoiceId: record.id, reason: 'no_due_date' });
      continue;
    }
    try {
      const invoice: Invoice = {
        id: record.id,
        supplierName: record.supplierName ?? '',
        invoiceNumber: record.invoiceNumber ?? '',
        totalCents: parseCents(record.taxFreeTotal) + parseCents(record.vatAmount),
        dueDate: parseCalendarDate(record.dueDate),
      };
      const sameTotal = byTotal.get(invoice.totalCents) ?? [];
      sameTotal.push(invoice);
      byTotal.set(invoice.totalCents, sameTotal);
    } catch (error) {
      if (!(error instanceof InvalidDataError)) throw error;
      skipped.push({ invoiceId: record.id, reason: 'invalid_data', detail: error.message });
    }
  }
  return { byTotal, skipped };
}

/**
 * Can this transaction be matched to a supplier invoice at all? The repository
 * already filters most of this in SQL; these are the rules that must also hold
 * in the core, so it stays safe whatever loads its input.
 */
function checkEligibility(record: TransactionRecord, transaction: Transaction): Decision | null {
  if (record.feedCopies > 1) {
    return {
      transactionId: record.id,
      outcome: 'duplicate_feed_row',
      detail: `${record.feedCopies} rows share this bank remote_id`,
    };
  }
  if (transaction.amountCents >= 0) {
    return {
      transactionId: record.id,
      outcome: 'not_outgoing',
      detail: `amount ${record.amount} is not a payment out of the account`,
    };
  }
  return null;
}

function decideOne(
  record: TransactionRecord,
  invoicesByTotal: Map<Cents, Invoice[]>,
  config: MatchingConfig,
): Decision {
  let transaction: Transaction;
  try {
    transaction = parseTransaction(record);
  } catch (error) {
    if (!(error instanceof InvalidDataError)) throw error;
    return { transactionId: record.id, outcome: 'invalid_data', detail: error.message };
  }

  const ineligible = checkEligibility(record, transaction);
  if (ineligible) {
    return ineligible;
  }

  const paidCents = -transaction.amountCents;
  const candidates = (invoicesByTotal.get(paidCents) ?? []).filter((invoice) => {
    const days = daysBetween(transaction.date, invoice.dueDate);
    return days >= -config.windowDaysBefore && days <= config.windowDaysAfter;
  });
  if (candidates.length === 0) {
    return { transactionId: record.id, outcome: 'no_candidate' };
  }

  for (const strategy of config.strategies) {
    const result = strategy.decide(transaction, candidates);
    if (result.kind === 'match') {
      return {
        transactionId: record.id,
        outcome: 'matched',
        invoiceId: result.invoice.id,
        strategy: strategy.name,
      };
    }
    if (result.kind === 'reject') {
      return {
        transactionId: record.id,
        outcome: result.reason,
        detail: result.detail,
        candidateInvoiceIds: candidates.map((c) => c.id),
      };
    }
  }
  return {
    transactionId: record.id,
    outcome: 'ambiguous',
    detail: `${candidates.length} candidate invoices, none singled out`,
    candidateInvoiceIds: candidates.map((c) => c.id),
  };
}

/**
 * Pure matching core: no I/O. Given open transactions and open invoices,
 * returns one decision per transaction, and the invoices that couldn't be
 * considered at all.
 *
 * Two transactions that pick the same invoice are both downgraded to
 * `conflict`: we don't know which one really paid it.
 */
export function decide(
  transactions: readonly TransactionRecord[],
  invoices: readonly InvoiceRecord[],
  config: MatchingConfig = DEFAULT_CONFIG,
): DecideResult {
  const { byTotal, skipped } = parseInvoices(invoices);
  const decisions = transactions.map((record) => decideOne(record, byTotal, config));

  const claims = new Map<string, number>();
  for (const decision of decisions) {
    if (decision.outcome === 'matched') {
      claims.set(decision.invoiceId, (claims.get(decision.invoiceId) ?? 0) + 1);
    }
  }

  return {
    skippedInvoices: skipped,
    decisions: decisions.map((decision): Decision => {
      if (decision.outcome !== 'matched' || claims.get(decision.invoiceId) === 1) {
        return decision;
      }
      return {
        transactionId: decision.transactionId,
        outcome: 'conflict',
        candidateInvoiceIds: [decision.invoiceId],
        detail: `invoice ${decision.invoiceId} is claimed by ${claims.get(decision.invoiceId)} transactions`,
      };
    }),
  };
}

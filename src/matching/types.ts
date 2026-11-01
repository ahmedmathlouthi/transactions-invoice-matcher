import type { CalendarDate } from '../dates';
import type { Cents } from '../money';

/** A transaction row as the repository loads it: raw text, not yet trusted. */
export type TransactionRecord = {
  id: string;
  amount: string;
  label: string | null;
  reference: string | null;
  date: string | null;
  /** The bank's own id for the row. Unique per account in a healthy feed. */
  remoteId: string | null;
  /** How many live rows share this (account_id, remote_id). > 1 means a duplicated feed row. */
  feedCopies: number;
};

/** An invoice row as the repository loads it: raw text, not yet trusted. */
export type InvoiceRecord = {
  id: string;
  supplierName: string | null;
  invoiceNumber: string | null;
  taxFreeTotal: string;
  vatAmount: string;
  dueDate: string | null;
};

/** A parsed transaction. `amountCents` is signed as the bank reports it: negative = money out. */
export type Transaction = {
  id: string;
  amountCents: Cents;
  label: string;
  reference: string;
  date: CalendarDate;
};

export type Invoice = {
  id: string;
  supplierName: string;
  invoiceNumber: string;
  totalCents: Cents;
  dueDate: CalendarDate;
};

export type RejectReason = 'reference_mismatch' | 'ambiguous';

export type StrategyResult =
  | { kind: 'match'; invoice: Invoice }
  | { kind: 'reject'; reason: RejectReason; detail?: string }
  | { kind: 'pass' };

/**
 * One way of choosing an invoice among the candidates (same amount, due date in
 * the window). Strategies run in priority order: the first `match` or `reject`
 * decides; if all pass, the transaction is left unmatched as `ambiguous`.
 */
export interface MatchStrategy {
  readonly name: string;
  decide(transaction: Transaction, candidates: readonly Invoice[]): StrategyResult;
}

export type Outcome =
  | 'matched'
  | 'no_candidate'
  | 'ambiguous'
  | 'reference_mismatch'
  | 'duplicate_feed_row'
  | 'not_outgoing'
  | 'conflict'
  | 'invalid_data';

export type Decision =
  | { transactionId: string; outcome: 'matched'; invoiceId: string; strategy: string }
  | {
      transactionId: string;
      outcome: Exclude<Outcome, 'matched'>;
      detail?: string;
      /** The invoices that were in play, for a human to review (ambiguous, mismatch, conflict). */
      candidateInvoiceIds?: string[];
    };

export type MatchedDecision = Extract<Decision, { outcome: 'matched' }>;

export type SkippedInvoice = {
  invoiceId: string;
  reason: 'no_due_date' | 'invalid_data';
  detail?: string;
};

export type MatchingConfig = {
  /** The due date may be up to this many days before the transaction date. */
  windowDaysBefore: number;
  /** The due date may be up to this many days after the transaction date. */
  windowDaysAfter: number;
  strategies: readonly MatchStrategy[];
};

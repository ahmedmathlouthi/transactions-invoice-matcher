import type { Invoice, MatchStrategy, Transaction } from './types';

const MIN_TOKEN_LENGTH = 3;

/** Lowercase, strip accents, keep letters and digits as space-separated words. */
export function tokenize(value: string): string[] {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function normalizeInvoiceNumber(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * The bank reference names the invoice. It's the strongest signal we have, so
 * it also vetoes: if the reference names an invoice that isn't among the
 * candidates, the payment is for something else and must not be paired with a
 * look-alike.
 */
export const referenceStrategy: MatchStrategy = {
  name: 'reference',
  decide(transaction, candidates) {
    const reference = normalizeInvoiceNumber(transaction.reference);
    if (reference === '') {
      return { kind: 'pass' };
    }
    const named = candidates.filter(
      (invoice) =>
        invoice.invoiceNumber !== '' && normalizeInvoiceNumber(invoice.invoiceNumber) === reference,
    );
    if (named.length === 1) {
      return { kind: 'match', invoice: named[0] };
    }
    if (named.length > 1) {
      return { kind: 'reject', reason: 'ambiguous', detail: `invoice number ${reference} is not unique` };
    }
    return {
      kind: 'reject',
      reason: 'reference_mismatch',
      detail: `reference ${reference} names no candidate invoice`,
    };
  },
};

/** The README rule: exactly one open invoice with this amount and a due date in the window. */
export const uniqueAmountDateStrategy: MatchStrategy = {
  name: 'unique_amount_date',
  decide(_transaction, candidates) {
    return candidates.length === 1 ? { kind: 'match', invoice: candidates[0] } : { kind: 'pass' };
  },
};

/** Every significant word of the supplier name appears as a whole word in the label. */
export function labelNamesSupplier(label: string, supplierName: string): boolean {
  const supplierTokens = tokenize(supplierName).filter((t) => t.length >= MIN_TOKEN_LENGTH);
  if (supplierTokens.length === 0) {
    return false;
  }
  const labelTokens = new Set(tokenize(label));
  return supplierTokens.every((token) => labelTokens.has(token));
}

/**
 * Several candidates: pick one only if it is the single candidate whose
 * supplier the label names. Two candidates from the same supplier (recurring
 * bills) stay ambiguous on purpose.
 */
export const supplierNameStrategy: MatchStrategy = {
  name: 'supplier_name',
  decide(transaction: Transaction, candidates: readonly Invoice[]) {
    const named = candidates.filter((invoice) =>
      labelNamesSupplier(transaction.label, invoice.supplierName),
    );
    return named.length === 1 ? { kind: 'match', invoice: named[0] } : { kind: 'pass' };
  },
};

export const DEFAULT_STRATEGIES: readonly MatchStrategy[] = [
  referenceStrategy,
  uniqueAmountDateStrategy,
  supplierNameStrategy,
];

import type { InvoiceRecord, TransactionRecord } from '../src/matching/types';

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}`;

export function tx(overrides: Partial<TransactionRecord> = {}): TransactionRecord {
  return {
    id: nextId('tx'),
    amount: '-44.99',
    label: 'PRLV SEPA BOUYGUES TELECOM',
    reference: '',
    date: '2026-04-09',
    remoteId: null,
    feedCopies: 1,
    ...overrides,
  };
}

export function invoice(overrides: Partial<InvoiceRecord> = {}): InvoiceRecord {
  return {
    id: nextId('inv'),
    supplierName: 'Bouygues Telecom',
    invoiceNumber: `F-2026-${String(seq).padStart(5, '0')}`,
    taxFreeTotal: '37.49',
    vatAmount: '7.50',
    dueDate: '2026-04-10',
    ...overrides,
  };
}

import type { Pool } from 'pg';
import type { InvoiceRecord, MatchedDecision, TransactionRecord } from './matching/types';

export type Company = { id: string; siren: string; name: string | null };

export type MatchToRecord = Pick<MatchedDecision, 'transactionId' | 'invoiceId' | 'strategy'>;

export interface MatchingRepository {
  findCompanyBySiren(siren: string): Promise<Company | null>;
  /** Outgoing, booked, live, not yet matched transactions of the company. */
  loadOpenTransactions(companyId: string): Promise<TransactionRecord[]>;
  /** Live, payable (`ToPay`/`Pending`) invoices that no transaction points to yet. */
  loadOpenInvoices(companyId: string): Promise<InvoiceRecord[]>;
  /**
   * Writes all matches atomically and returns how many rows were written.
   * Assumes the caller (web app / worker) never runs two jobs for a company at once.
   */
  recordMatches(matchedAt: Date, matches: readonly MatchToRecord[]): Promise<number>;
}

/** Statuses an invoice can be paid in. Needs product confirmation (see FINDINGS.md §4). */
export const PAYABLE_INVOICE_STATUSES = ['ToPay', 'Pending'] as const;

/**
 * The money columns are `real` (float4). `real::text` can print `1e+06`, so read
 * them as exact 2-decimal text; `parseCents` does the rest without floats.
 */
const money = (column: string) => `round(${column}::numeric, 2)::text`;

export function createPgRepository(pool: Pool): MatchingRepository {
  return {
    async findCompanyBySiren(siren) {
      const { rows } = await pool.query<Company>(
        'select id, siren, name from company where siren = $1',
        [siren],
      );
      return rows[0] ?? null;
    },

    async loadOpenTransactions(companyId) {
      const { rows } = await pool.query<TransactionRecord>(
        `select t.id,
                ${money('t.amount')} as amount,
                t.label,
                t.reference,
                t.date::text as date,
                t.remote_id as "remoteId",
                greatest(1, (
                  select count(*)
                  from transaction d
                  where d.account_id = t.account_id
                    and d.remote_id = t.remote_id
                    and d.deleted_at is null
                ))::int as "feedCopies"
         from transaction t
         join account a on a.id = t.account_id
         where a.company_id = $1
           and t.amount < 0
           and t.status = 'Booked'
           and t.deleted_at is null
           and t.matched_invoice_id is null
         order by t.date, t.id`,
        [companyId],
      );
      return rows;
    },

    async loadOpenInvoices(companyId) {
      const { rows } = await pool.query<InvoiceRecord>(
        `select i.id,
                i.supplier_name as "supplierName",
                i.invoice_number as "invoiceNumber",
                ${money('i.tax_free_total')} as "taxFreeTotal",
                ${money('i.vat_amount')} as "vatAmount",
                i.due_date as "dueDate"
         from buying_invoice i
         where i.company_id = $1
           and i.deleted_at is null
           and i.invoice_status = any($2::text[])
           and not exists (
             select 1 from transaction m where m.matched_invoice_id = i.id
           )`,
        [companyId, PAYABLE_INVOICE_STATUSES],
      );
      return rows;
    },

    async recordMatches(matchedAt, matches) {
      // One statement, so Postgres applies it all-or-nothing: no explicit transaction needed.
      // The `is null` guard means a match someone already made (e.g. by hand) is never overwritten.
      const { rowCount } = await pool.query(
        `update transaction t
         set matched_invoice_id = m.invoice_id,
             matched_at = $3
         from unnest($1::uuid[], $2::uuid[]) as m(transaction_id, invoice_id)
         where t.id = m.transaction_id
           and t.matched_invoice_id is null`,
        [matches.map((m) => m.transactionId), matches.map((m) => m.invoiceId), matchedAt],
      );
      return rowCount ?? 0;
    },
  };
}

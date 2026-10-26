import { db } from "./db";

type TransactionRow = {
  id: string;
  amount: number;
  label: string;
  date: Date;
};

type InvoiceRow = {
  id: string;
  supplier_name: string;
  invoice_number: string;
  tax_free_total: number;
  vat_amount: number;
  due_date: string;
};

export function normalizeLabel(value: string): string {
  return value.trim().toLowerCase();
}

export function dayDiff(a: Date | string, b: Date | string): number {
  return Math.floor((new Date(a).getTime() - new Date(b).getTime()) / 86400000);
}

function scoreCandidate(
  transaction: TransactionRow,
  invoice: InvoiceRow,
): number {
  const label = normalizeLabel(transaction.label);
  let score = Math.abs(dayDiff(transaction.date, invoice.due_date));

  if (
    label.includes(normalizeLabel(invoice.supplier_name)) ||
    label.includes(normalizeLabel(invoice.invoice_number))
  ) {
    score -= 100;
  }

  return score;
}

function findMatch(
  transaction: TransactionRow,
  invoices: InvoiceRow[],
): InvoiceRow | null {
  const candidates = invoices
    .filter(
      (invoice) =>
        invoice.tax_free_total + invoice.vat_amount ===
        Math.abs(transaction.amount),
    )
    .filter((invoice) => {
      const diff = dayDiff(transaction.date, invoice.due_date);
      return diff >= -30 && diff <= 3;
    });

  if (candidates.length === 0) {
    return null;
  }

  const scored = candidates.map((invoice) => ({
    invoice,
    score: scoreCandidate(transaction, invoice),
  }));
  scored.sort((a, b) => a.score - b.score);
  return scored[0].invoice;
}

async function getCandidates(companyId: string): Promise<InvoiceRow[]> {
  const { rows } = await db.query(
    `select * from buying_invoice where company_id = '${companyId}'`,
  );
  return rows;
}

export async function runAutoMatching(companySiren: string): Promise<void> {
  const {
    rows: [company],
  } = await db.query(`select * from company where siren = '${companySiren}'`);

  const { rows: transactions } = await db.query<TransactionRow>(
    `select transaction.*
     from transaction
     join account on account.id = transaction.account_id
     where account.company_id = '${company.id}'`,
  );

  let matched = 0;

  for (const transaction of transactions) {
    try {
      const invoice = findMatch(transaction, await getCandidates(company.id));
      if (!invoice) {
        continue;
      }

      await db.query(
        `update transaction set matched_invoice_id = '${invoice.id}' where id = '${transaction.id}'`,
      );
      matched++;
    } catch (e) {
      console.log("skip", e);
    }
  }

  console.log(`Matched ${matched} of ${transactions.length} transactions`);
}

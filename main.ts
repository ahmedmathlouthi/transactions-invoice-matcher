import fs from 'fs';
import path from 'path';
import { db } from './src/db';
import { AppError } from './src/errors';
import { runAutoMatching } from './src/job';
import { SKIPPED_INVOICE_COLUMNS, TRANSACTION_COLUMNS, toCsv, type Report } from './src/report';
import { createPgRepository } from './src/repository';

const DEFAULT_SIREN = '900997767';
const REPORTS_DIR = path.join(__dirname, 'reports');

function writeReports(report: Report, siren: string): string[] {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(REPORTS_DIR, `${siren}_${stamp}`);
  // The BOM makes Excel read accented supplier names as UTF-8.
  const files: [string, string][] = [
    [`${base}_transactions.csv`, toCsv(TRANSACTION_COLUMNS, report.transactions)],
    [`${base}_invoices-skipped.csv`, toCsv(SKIPPED_INVOICE_COLUMNS, report.skippedInvoices)],
  ];
  for (const [file, csv] of files) {
    fs.writeFileSync(file, '\uFEFF' + csv, 'utf8');
  }
  return files.map(([file]) => path.relative(process.cwd(), file));
}

async function main(): Promise<number> {
  const siren = process.argv[2] ?? DEFAULT_SIREN;
  try {
    const { summary, report } = await runAutoMatching(siren, { repo: createPgRepository(db) });
    console.log(
      `Matched ${summary.matched} of ${summary.transactionsConsidered} open transactions ` +
        `(company ${summary.siren})`,
    );
    console.log(JSON.stringify(summary, null, 2));

    const flags = report.transactions.reduce<Record<string, number>>((acc, row) => {
      acc[row.flag] = (acc[row.flag] ?? 0) + 1;
      return acc;
    }, {});
    try {
      const files = writeReports(report, summary.siren);
      console.log(`CSV report (${Object.entries(flags).map(([f, n]) => `${f} ${n}`).join(', ')}):`);
      for (const file of files) console.log(`  ${file}`);
    } catch (error) {
      // The matches are already committed; a failed export must not hide that.
      console.error('Matching succeeded, but writing the CSV report failed:', error);
      return 4;
    }
    return 0;
  } catch (error) {
    if (error instanceof AppError) {
      console.error(`${error.code}: ${error.message}`);
      return error.exitCode;
    }
    console.error('Unexpected failure:', error);
    return 1;
  } finally {
    await db.end();
  }
}

main().then((code) => {
  process.exitCode = code;
});

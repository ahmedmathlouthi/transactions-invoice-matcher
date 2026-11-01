import fs from 'fs';
import path from 'path';
import { db } from './src/db';
import { AppError } from './src/errors';
import { runAutoMatching } from './src/job';
import { REVIEW_COLUMNS, toCsv, type ReviewRow } from './src/report';
import { createPgRepository } from './src/repository';

const DEFAULT_SIREN = '900997767';
const REPORTS_DIR = path.join(__dirname, 'reports');

/** Writes the finance review sheet and returns its path. */
function writeReviewSheet(rows: ReviewRow[], siren: string): string {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(REPORTS_DIR, `${siren}_${stamp}_to-review.csv`);
  // The BOM makes Excel read accented supplier names as UTF-8.
  fs.writeFileSync(file, '\uFEFF' + toCsv(REVIEW_COLUMNS, rows), 'utf8');
  return path.relative(process.cwd(), file);
}

async function main(): Promise<number> {
  const siren = process.argv[2] ?? DEFAULT_SIREN;
  try {
    const { summary, review } = await runAutoMatching(siren, { repo: createPgRepository(db) });
    console.log(
      `Matched ${summary.matched} of ${summary.transactionsConsidered} open transactions ` +
        `(company ${summary.siren})`,
    );
    console.log(JSON.stringify(summary, null, 2));

    try {
      const file = writeReviewSheet(review, summary.siren);
      const toReview = new Set(review.map((row) => row.transaction_id)).size;
      console.log(`${toReview} ambiguous transactions to review (${review.length} candidate invoices): ${file}`);
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

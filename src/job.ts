import { CompanyNotFoundError, InvalidInputError } from './errors';
import { decide, DEFAULT_CONFIG } from './matching/decide';
import type { Decision, MatchedDecision, MatchingConfig, Outcome, SkippedInvoice } from './matching/types';
import { buildReport, type Report } from './report';
import type { MatchingRepository } from './repository';

export type Logger = Pick<Console, 'info' | 'warn'>;

export type JobDeps = {
  repo: MatchingRepository;
  logger?: Logger;
  now?: () => Date;
  config?: MatchingConfig;
};

export type RunSummary = {
  companyId: string;
  siren: string;
  transactionsConsidered: number;
  invoicesConsidered: number;
  matched: number;
  /** Only the outcomes that occurred in this run. */
  outcomes: Partial<Record<Outcome, number>>;
  matchedByStrategy: Record<string, number>;
  /** Only the reasons that occurred in this run. */
  skippedInvoices: Partial<Record<SkippedInvoice['reason'], number>>;
  durationMs: number;
};

export type RunResult = {
  summary: RunSummary;
  /** Row-level detail of the run, for the CSV export. */
  report: Report;
};

const SIREN = /^\d{9}$/;

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

export async function runAutoMatching(siren: string, deps: JobDeps): Promise<RunResult> {
  const {
    repo,
    logger = console,
    now = () => new Date(),
    config = DEFAULT_CONFIG,
  } = deps;
  const startedAt = now();

  if (!SIREN.test(siren)) {
    throw new InvalidInputError(`SIREN must be exactly 9 digits, got ${JSON.stringify(siren)}`);
  }
  const company = await repo.findCompanyBySiren(siren);
  if (!company) {
    throw new CompanyNotFoundError(siren);
  }

  const [transactions, invoices] = await Promise.all([
    repo.loadOpenTransactions(company.id),
    repo.loadOpenInvoices(company.id),
  ]);

  const { decisions, skippedInvoices } = decide(transactions, invoices, config);
  const matches = decisions.filter((d): d is MatchedDecision => d.outcome === 'matched');

  const written = await repo.recordMatches(startedAt, matches);

  for (const d of decisions) {
    if (d.outcome === 'invalid_data' || d.outcome === 'conflict' || d.outcome === 'duplicate_feed_row') {
      logger.warn(`transaction ${d.transactionId}: ${d.outcome} (${d.detail ?? ''})`);
    }
  }

  const summary: RunSummary = {
    companyId: company.id,
    siren,
    transactionsConsidered: transactions.length,
    invoicesConsidered: invoices.length,
    matched: written,
    outcomes: countBy(decisions, (d: Decision) => d.outcome),
    matchedByStrategy: countBy(matches, (m) => m.strategy),
    skippedInvoices: countBy(skippedInvoices, (s) => s.reason),
    durationMs: now().getTime() - startedAt.getTime(),
  };
  const report = buildReport({ transactions, invoices, decisions, skippedInvoices });
  return { summary, report };
}

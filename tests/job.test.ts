import { describe, expect, it, vi } from 'vitest';
import { CompanyNotFoundError, InvalidInputError } from '../src/errors';
import { runAutoMatching } from '../src/job';
import { invoice, tx } from './fixtures';
import type { InvoiceRecord, TransactionRecord } from '../src/matching/types';
import type { MatchingRepository } from '../src/repository';

const COMPANY = { id: 'c1', siren: '900997767', name: 'Atelier' };

function fakeRepo(
  transactions: TransactionRecord[],
  invoices: InvoiceRecord[],
  overrides: Partial<MatchingRepository> = {},
): MatchingRepository {
  return {
    findCompanyBySiren: async (siren) => (siren === COMPANY.siren ? COMPANY : null),
    loadOpenTransactions: async () => transactions,
    loadOpenInvoices: async () => invoices,
    recordMatches: async (_at, matches) => matches.length,
    ...overrides,
  };
}

const silent = { info: vi.fn(), warn: vi.fn() };

describe('runAutoMatching', () => {
  it('rejects a malformed SIREN before touching the database', async () => {
    const repo = fakeRepo([], []);
    const spy = vi.spyOn(repo, 'findCompanyBySiren');
    await expect(runAutoMatching("1' or '1'='1", { repo, logger: silent })).rejects.toThrow(InvalidInputError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('reports an unknown company clearly', async () => {
    await expect(runAutoMatching('123456789', { repo: fakeRepo([], []), logger: silent })).rejects.toThrow(
      CompanyNotFoundError,
    );
  });

  it('lets infrastructure errors propagate instead of swallowing them (finding 10)', async () => {
    const repo = fakeRepo([tx()], [invoice()], {
      recordMatches: async () => {
        throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      },
    });
    await expect(runAutoMatching(COMPANY.siren, { repo, logger: silent })).rejects.toThrow('ECONNRESET');
  });

  it('writes only the matched decisions and summarises every outcome', async () => {
    const recordMatches = vi.fn<MatchingRepository['recordMatches']>(async (_at, matches) => matches.length);
    const matching = tx();
    const { summary } = await runAutoMatching(COMPANY.siren, {
      repo: fakeRepo([matching, tx({ amount: '-1.00' }), tx({ amount: 'oops' })], [invoice()], { recordMatches }),
      logger: silent,
    });

    expect(recordMatches.mock.calls[0][1]).toEqual([
      expect.objectContaining({ transactionId: matching.id, strategy: 'unique_amount_date' }),
    ]);
    expect(summary).toMatchObject({
      matched: 1,
      transactionsConsidered: 3,
      outcomes: { matched: 1, no_candidate: 1, invalid_data: 1 },
      matchedByStrategy: { unique_amount_date: 1 },
    });
    expect(summary).not.toHaveProperty('runId');
    expect(summary).not.toHaveProperty('lostRace');
    // Outcomes that didn't occur are left out of the summary.
    expect(summary.outcomes).toEqual({ matched: 1, no_candidate: 1, invalid_data: 1 });
    expect(summary.skippedInvoices).toEqual({});
  });

  it('reports the rows actually written, not the decisions', async () => {
    // e.g. the `matched_invoice_id is null` guard skipped a row someone matched by hand meanwhile
    const { summary } = await runAutoMatching(COMPANY.siren, {
      repo: fakeRepo([tx()], [invoice()], { recordMatches: async () => 0 }),
      logger: silent,
    });
    expect(summary).toMatchObject({ matched: 0, outcomes: { matched: 1 } });
  });
});

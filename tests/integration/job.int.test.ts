import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db';
import { runAutoMatching, type RunSummary } from '../../src/job';
import { createPgRepository } from '../../src/repository';
import { resetSchema } from '../../src/schema';

const SIREN = '900997767';
const quiet = { info: () => {}, warn: () => {} };

async function ensureTestDatabase() {
  const admin = new Client({
    host: process.env.PGHOST ?? 'localhost',
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'postgres',
    password: process.env.PGPASSWORD ?? 'postgres',
    database: 'postgres',
  });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('select 1 from pg_database where datname = $1', ['matching_test']);
    if (!rowCount) await admin.query('create database matching_test');
  } finally {
    await admin.end();
  }
}

const count = async (sql: string) => Number((await db.query<{ n: string }>(sql)).rows[0].n);

describe('auto-matching against the seed (needs Docker)', () => {
  let first: RunSummary;

  beforeAll(async () => {
    expect(process.env.PGDATABASE).toBe('matching_test');
    await ensureTestDatabase();
    await resetSchema(db);
    ({ summary: first } = await runAutoMatching(SIREN, { repo: createPgRepository(db), logger: quiet }));
  });

  afterAll(async () => {
    await db.end();
  });

  it('matches something, and accounts for every transaction', () => {
    expect(first.matched).toBeGreaterThan(0);
    const total = Object.values(first.outcomes).reduce((a, b) => a + b, 0);
    expect(total).toBe(first.transactionsConsidered);
  });

  it.each([
    [
      'invoice not payable (paid, cancelled or deleted)',
      `select count(*) as n from transaction t join buying_invoice i on i.id = t.matched_invoice_id
       where i.invoice_status not in ('ToPay', 'Pending') or i.deleted_at is not null`,
    ],
    [
      'invoice claimed twice',
      `select count(*) as n from (select matched_invoice_id from transaction
       where matched_invoice_id is not null group by 1 having count(*) > 1) x`,
    ],
    [
      'incoming, deleted or pending transaction',
      `select count(*) as n from transaction
       where matched_invoice_id is not null and (amount >= 0 or deleted_at is not null or status <> 'Booked')`,
    ],
    [
      'amount differs',
      `select count(*) as n from transaction t join buying_invoice i on i.id = t.matched_invoice_id
       where round((-t.amount)::numeric, 2) <> round(i.tax_free_total::numeric, 2) + round(i.vat_amount::numeric, 2)`,
    ],
    [
      'due date outside the window',
      `select count(*) as n from transaction t join buying_invoice i on i.id = t.matched_invoice_id
       where i.due_date::date - t.date not between -3 and 30`,
    ],
    [
      'reference names another invoice',
      `select count(*) as n from transaction t join buying_invoice i on i.id = t.matched_invoice_id
       where t.reference <> '' and upper(trim(t.reference)) <> upper(trim(i.invoice_number))`,
    ],
    [
      'duplicated bank-feed row',
      `select count(*) as n from transaction t where t.matched_invoice_id is not null and exists (
         select 1 from transaction d where d.id <> t.id and d.account_id = t.account_id
           and d.remote_id = t.remote_id and d.deleted_at is null)`,
    ],
    [
      'matched_at set without a match',
      `select count(*) as n from transaction
       where matched_at is not null and matched_invoice_id is null`,
    ],
  ])('no match with: %s', async (_name, sql) => {
    expect(await count(sql)).toBe(0);
  });

  it('leaves the match that existed before the run untouched (finding 2)', async () => {
    const { rows } = await db.query(
      `select matched_invoice_id, matched_at from transaction where id = 'e0000005-0000-4000-8000-000000000001'`,
    );
    expect(rows).toEqual([{ matched_invoice_id: expect.any(String), matched_at: null }]);
    expect(await count(`select count(*) as n from transaction where matched_invoice_id is not null and matched_at is null`)).toBe(1);
  });

  it('is idempotent: a second run matches nothing new and changes nothing', async () => {
    const before = await db.query('select id, matched_invoice_id, matched_at from transaction order by id');
    const { summary: second } = await runAutoMatching(SIREN, { repo: createPgRepository(db), logger: quiet });
    const after = await db.query('select id, matched_invoice_id, matched_at from transaction order by id');

    expect(second.matched).toBe(0);
    expect(after.rows).toEqual(before.rows);
  });
});

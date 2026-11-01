# Findings: review of `src/matcher.ts`

The README's guiding constraint is: **"An incorrect pairing is worse than no pairing at all."**
The findings are ranked with that in mind. Anything that silently produces a wrong accounting
record ranks above security, performance and code structure.

Measured on the seed data (company `900997767`): one run matched **508 of 1,200** transactions
and took **~49 s**.

Checking those 508 matches against the data afterwards, **226 (44%) break at least one basic
rule** that needs no judgement call:

| Problem with the match | Matches |
|---|---|
| Invoice already `Paid` | 150 |
| Invoice `Cancelled` | 29 |
| Invoice soft-deleted (`deleted_at` set) | 12 |
| Same invoice matched to two transactions (13 invoices) | 26 |
| Transaction is incoming money (amount > 0) | 8 |
| Transaction is soft-deleted | 5 |
| Transaction still `Pending` at the bank | 22 |

The rows overlap, so they don't add up to 226. The 226 in finding 4 is a different set that happens
to be the same size. That count also leaves out wrong picks among
several valid candidates (findings 4–5), which can't be measured without ground truth. It assumes
`Pending` and `ToPay` are the payable invoice statuses, which needs product confirmation (see §4).

---

## 1. How the current implementation works

`main.ts` runs `runAutoMatching('900997767')` (hardcoded SIREN). In `src/matcher.ts`, the job:

1. finds the company with the SIREN pasted into the SQL text;
2. loads **every** transaction of its accounts, with no filter on sign, status, deletion or
   existing match;
3. for each transaction, re-queries **every** invoice of the company, keeps those whose
   `tax_free_total + vat_amount` equals `Math.abs(amount)` (float equality) with a due date from
   3 days before to 30 days after the transaction, ranks them by date gap with a −100 bonus if the
   label contains the supplier name or invoice number, and writes the best one with an `update`
   that also pastes values into the SQL;
4. catches any error with `console.log("skip", e)` and moves on, then prints `Matched X of Y`.

The schema stores money as `real`, `due_date` as `varchar` and statuses as free text, with no
foreign keys, `NOT NULL`, indexes or uniqueness rules. The two tests cover `normalizeLabel` and
`dayDiff` only.

---

## 2. Findings, ranked by production impact

Findings are numbered in order of harm, and grouped in three tiers.

| Tier | Harm | Findings |
|---|---|---|
| 1 | Wrong accounting records, or failures that hide them | 1–7 |
| 2 | Integrity, missed matches, security | 8–11 |
| 3 | Cost and speed of change | 12–15 |

---

### Tier 1: wrong accounting records, and the failures that hide them

All 226 measured bad matches in the summary table come from findings 1, 2 and 6.

#### 1. It never checks whether an invoice can still be paid
`getCandidates` returns every invoice of the company, including `Cancelled`, `Paid`, soft-deleted
ones (`deleted_at` set), and invoices **already matched to another transaction**.

Measured: 185 matches point to a paid, cancelled or deleted invoice, and 13 invoices are each
claimed by two transactions.

**Consequence:** payments get booked against cancelled or already-paid invoices, and the same
invoice can be marked paid twice. Supplier balances and the customer's books end up wrong.

#### 2. It doesn't filter which transactions it processes
- **Incoming money:** `Math.abs(transaction.amount)` makes credits look like payments, so a
  customer refund of €44.84 can be matched to a €44.84 supplier invoice.
- **Deleted transactions** (`deleted_at` set) and **pending transactions** (`status = 'Pending'`)
  are matched.
- **Transactions that already have a match:** every run re-matches them and **overwrites**
  `matched_invoice_id`, including matches a person corrected by hand.

Measured: 35 matches are on such transactions (8 incoming, 5 deleted, 22 pending).

**Consequence:** the job can't safely run more than once, it silently undoes users' corrections,
and it creates matches for money that never left the account.

#### 3. Errors are swallowed
The `catch` block logs `skip` and continues. On the seed data, the invoice with a `NULL`
`supplier_name` makes `normalizeLabel` throw (`matcher.ts:35` → `:20`). The throw happens while
scoring all candidates, so the whole transaction goes unmatched even when another candidate was
valid. The same `catch` hides a lost database connection: during a Docker outage, the job printed
one `skip ECONNRESET` per transaction and still exited normally with a summary line.

**Consequence:** partial or failed runs look like successful ones, so monitoring never alerts.

**Why third:** it hides findings 1 and 2, and everything below. The job keeps reporting success
while it writes wrong records, or none at all.

#### 4. It has no notion of ambiguity
**226 transactions** of company `900997767` have more than one invoice with the right amount
inside the date window. The code picks the closest due date (or whichever sorts first on a tie).
Recurring bills with identical amounts, like a monthly phone subscription at €44.99, are exactly
the case where the closest date is often the wrong invoice.

**Consequence:** systematic wrong matches on recurring suppliers. The README says to leave the
transaction unmatched when there is "no convincing candidate". The code has no concept of
confidence, margin between the top two candidates, or abstaining.

#### 5. The label check is weak, and the best signal is ignored
- `transaction.reference` often holds the exact invoice number (e.g. `F-2026-00003`) and is
  **never used**.
- If the transaction already names an invoice number, the code doesn't require it to agree with
  the candidate.
- A plain substring check gives false positives (short supplier names like `Elis` or `Uber` can
  appear inside unrelated words) and misses real matches (the bank label `CB METRO PARIS NANTERRE`
  doesn't contain the supplier name `Metro Cash & Carry`).
- **One invoice in the seed has an empty `invoice_number` (`''`).** `label.includes("")` is always
  `true`, so that invoice gets the −100 bonus against every transaction and wins every tie it's in.
- `invoice_number` has no uniqueness constraint. The seed has no duplicates, but nothing prevents
  them, so even an exact reference match isn't guaranteed to identify one invoice.

**Consequence:** the tie-breaker that's supposed to make ambiguous cases safer can confidently
pick the wrong invoice.

#### 6. Duplicate bank-feed rows are matched as if they were real payments
The bank feed delivered the same payment twice: two rows on account `…0001` with
`remote_id = BNK-2026-000777`, rent of −€1,500 on 2026-12-01. The job matches **both** to the
same rent invoice (`LOYER-2026-12`). Nothing deduplicates on `(account_id, remote_id)`, and the
schema has no unique constraint on it.

**Consequence:** a feed glitch turns into a double-paid invoice in the books. The matcher should
catch this kind of upstream problem, not spread it further.

#### 7. Dates can be off by one day
`pg` turns the `date` column into a JavaScript Date at **local** midnight, while
`new Date("2026-08-16")` reads the `varchar` due date as **UTC** midnight. In Europe/Paris
(UTC+1 or +2) the difference picks up a few hours, and `Math.floor` turns that into a whole day.

**Consequence:** invoices right at the −3 or +30 day edge of the window are wrongly accepted or
rejected, and the result depends on the server's timezone and on daylight saving time.

---

### Tier 2: integrity, missed matches and security

Missed matches rank below wrong ones, even at high volume: the customer sees work left to do by
hand, not a false record in the books.

#### 8. Writes are not safe or auditable
Each `update` stands alone: no database transaction, no `where matched_invoice_id is null` guard,
and no unique constraint on `matched_invoice_id`. Nothing records *why* a match was made (which
rule, what score, when, which run).

**Consequence:** two runs at the same time, or a run during a manual edit, race each other. A wrong
match can't be audited, explained to the customer, or reverted in bulk.

#### 9. Money is stored and compared as floating point
`real` holds only about 6–7 significant digits, and `tax_free_total + vat_amount === amount`
compares JavaScript floats exactly.

Measured: for **7,667 of 35,017 invoices (22%)**, `tax_free_total + vat_amount` in JavaScript is
not exactly the two-decimal total (e.g. `0.1 + 0.2 = 0.30000000000000004`). Those invoices can
never equal a transaction amount, so they are silently unmatchable.

**Consequence:** mostly missed matches today. For large amounts, `real` rounding can also make two
different values look equal, which produces a wrong match. Money needs `numeric(…,2)` or whole
cents (integer).

**Why Tier 2:** it mostly causes **missed** matches, not wrong ones, even though it affects far
more records than the findings above it.

#### 10. Invoices without a due date can never match
**1,051 invoices have a `NULL` `due_date`.** `new Date(null)` is 1970-01-01, so they fall outside
every date window. Nothing reports or counts them.

**Consequence:** silent missed matches. The customer just sees work left for them to do by hand,
with no explanation.

#### 11. SQL injection
All four queries paste values into the SQL text. Today the inputs come from the code itself or the
database, but `companySiren` will come from an API or queue someday, and any value containing a
quote already breaks the query.

**Consequence:** easy to exploit once exposed, and the fix is trivial (`$1` parameters). It sits in
Tier 2 only because the README says wrong matches are the damage that matters most, and this one
isn't exposed yet.

---

### Tier 3: cost and speed of change

#### 12. It's slow because of N+1 queries
About 1,200 transactions × one "all 35,017 invoices of the company" query each, so roughly
42 million rows are read for one small company, which takes **~49 s**.

**Consequence:** timeouts and heavy database load at real customer volumes. Load invoices once and
index them by amount, or do the amount and date filtering in SQL.

#### 13. No structure, and no real tests
Business rules, SQL and orchestration all live in one function, and `findMatch` and
`scoreCandidate` aren't even exported, so none of the rules above can be tested without a database.
The only two tests check `normalizeLabel` and `dayDiff`. See §3.

**Consequence:** none of the Tier 1 fixes can be proven correct, and each one ships with regression
risk.

#### 14. The schema enforces nothing
No foreign keys, no `NOT NULL`, no `CHECK` constraints or enums on statuses, no indexes, no
uniqueness on `(account_id, remote_id)` or invoice numbers, and `due_date` stored as `varchar`.

**Consequence:** bad data gets in quietly, and the matcher pays for it. The seed shows each case:
an empty invoice number that wins every tie (finding 5), a `NULL` supplier name that crashes
scoring (finding 3), 1,051 missing due dates (finding 10), a duplicated bank row (finding 6), and a
transaction whose account doesn't exist.

#### 15. Smaller issues
- A missing company crashes with an unhelpful `TypeError`.
- The SIREN is hardcoded in `main.ts`.
- The magic numbers `-30`, `3` and `-100` aren't named.
- `select *` is used throughout.
- The TypeScript types claim fields can't be null when the data has nulls (`due_date`,
  `supplier_name`).

**Consequence:** slower diagnosis and harder reading, but no wrong records on their own.

---

## 3. Code structure review

**Yes, it's under-structured, and that matters here.** `matcher.ts` mixes data access, eligibility
rules (missing, hence findings 1, 2 and 6), the matching decision, writes and reporting in one
function. The core problem is that **the decision isn't a pure function**, so the test that matters
most can't be written: "given these transactions and invoices, this is matched, this is left alone,
and why". It shouldn't become a layered enterprise design either.

### What I built

```
main.ts              CLI: SIREN in, run summary and review CSV out, typed exit codes
src/
  db.ts              pool (unchanged)
  money.ts           text → integer cents, never floats
  dates.ts           YYYY-MM-DD calendar days, timezone-free
  errors.ts          typed errors with exit codes
  repository.ts      all SQL, parameterised: company, open transactions, open invoices,
                     recordMatches (one guarded UPDATE)
  matching/
    types.ts         records, outcomes, strategy interface
    decide.ts        PURE: eligibility, candidates, strategies, conflicts
    strategies.ts    reference → single candidate → supplier named in the label
  report.ts          review CSV for finance
  job.ts             load → decide → write → summary
  schema.ts          reset helper for db:reset and the integration tests
```

- **Pure core.** `decide` imports nothing from `pg`. Most tests run on it in memory; a few run the
  real job against the Docker database.
- **Repository as a thin interface**, not a pattern for its own sake: one place for "open invoice"
  and "open transaction" in SQL, and a fake in the job tests.
- **Strategies as an ordered list.** Each can match, reject or pass, so a rule can veto a match,
  and new rules don't touch the others.
- **Ambiguous is an outcome.** That is the structural fix for finding 4: "unsure" becomes something
  the code can say.

### What changed from my first plan
- **No explicit database transaction.** The write is a single `UPDATE … FROM unnest(…)`, which
  Postgres applies all or nothing, with a `matched_invoice_id is null` guard.
- **No audit table.** Only a `matched_at` column, because I treated the database as production.
  The run summary counts matches per strategy, but which rule made each match isn't stored.
- **No confidence margin.** The job matches only when exactly one candidate survives the rules,
  which is stricter and simpler to defend.

No DI container, service classes, generic `Repository<T>` or ORM: plain functions with typed inputs,
and dependencies passed as parameters.

---

## 4. Note: what's left undone, open product questions, next steps

### Left undone, on purpose
- Only one migration: a nullable `matched_at` column. The database is treated as production.
  It is a minimal audit log, set by the job only:
  - every match of a run gets the run's start time, so `matched_at` identifies the run;
  - `NULL` with a match means the match existed before (e.g. made by hand), and the job never
    touches it;
  - a bad run can be listed or undone in one statement, by its `matched_at`;
  - not yet stored: which rule made each match, or who made a manual one (a `matched_by` column).
- Schema follow-ups, each needing a clean-up or a zero-downtime migration first:
  - amounts `real` → `numeric(14,2)`; amounts above ~€10,000 may have lost cents and must be
    re-imported
  - unique index on `transaction(matched_invoice_id)`, after cleaning up double matches
  - unique `(account_id, remote_id)`, so a bank movement can't be stored twice
  - lookup indexes, built `concurrently`
  - `due_date` `varchar` → `date`
- Concurrency is left to the caller: one run per company at a time.
- The final `UPDATE` doesn't re-check that the invoice is still open and unmatched.
- Matches the original job may have written in production are not audited.

### Needed from product
- Which invoice statuses can be paid? I assumed `ToPay` and `Pending`.
- What to do with invoices without a due date? 646 open ones can never match today.
- Can recurring payments go to the oldest open invoice first? That would resolve 144 of the 149
  ambiguous transactions.
- Is the window (3 days before, 30 days after) right? Are amounts always exact?

### Next steps
1. Re-check the invoice inside the `UPDATE` (no schema change).
2. Run the job from a queue, one run per company, triggered by new transactions and new invoices.
   Select work by state, not by a "last run" timestamp.
3. Audit existing matches, then add the unique index on `matched_invoice_id`.
4. Read finance's choices back from the review sheet.
5. Move amounts to `numeric` and due dates to `date`.

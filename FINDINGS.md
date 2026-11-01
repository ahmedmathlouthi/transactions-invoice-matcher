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

**`main.ts`** calls `runAutoMatching('900997767')` with a hardcoded SIREN (French company number), then closes the pool.

**`src/db.ts`** exports one shared `pg` `Pool`, configured from `PG*` environment variables with local defaults.

**`src/matcher.ts` → `runAutoMatching(companySiren)`**

1. **Find the company**: `select * from company where siren = '${companySiren}'`. The value is
   pasted into the SQL text. If no row matches, `company` is `undefined` and `company.id` throws.
2. **Load all transactions** on the company's accounts. Nothing filters them: not by sign,
   `status`, `deleted_at` or `matched_invoice_id`.
3. **For each transaction:**
   - `getCandidates()` re-queries **every invoice of the company** (one query per transaction).
   - `findMatch()` keeps the invoices where:
     - `tax_free_total + vat_amount === Math.abs(transaction.amount)` (JavaScript float equality);
     - `dayDiff(tx.date, due_date)` is in `[-30, 3]`, so the due date falls between 3 days before
       and 30 days after the transaction (this is the window the README specifies).
   - If several invoices remain, `scoreCandidate()` ranks them by `|days between|`, minus 100 if
     the label contains the supplier name or the invoice number. The lowest score wins.
   - `update transaction set matched_invoice_id = '…' where id = '…'`, with values pasted into the SQL text.
   - Any error is caught, printed as `console.log("skip", e)`, and the loop continues.
4. Prints `Matched X of Y transactions`.

**`scripts/reset.ts`** drops the `public` schema, then runs every `.sql` file in `migrations/` and `seeds/` in sorted order.

**Schema**: money is stored as `real` (low-precision floating point), `due_date` as `varchar`, and
statuses as free text. There are no foreign keys, no `NOT NULL` constraints, no indexes, and no
uniqueness rule on matches.

**Tests**: two trivial tests (`normalizeLabel`, `dayDiff`). The matching logic is not tested,
and `findMatch` and `scoreCandidate` aren't even exported.

---

## 2. Findings, ranked by production impact

The findings are grouped by theme, and the groups are ordered by impact. Numbering runs across
groups, so the numbers still give the overall ranking.

| Group | Tier | Findings |
|---|---|---|
| A. It matches against records that should never match | 1: wrong accounting records | 1–3 |
| B. When several invoices fit, it picks one anyway | 1: wrong accounting records | 4–5 |
| C. Amounts and dates are compared incorrectly | 1: wrong or silently missed records | 6–8 |
| D. Writes and failures are unsafe and invisible | 2: integrity, safety, observability | 9–11 |
| E. Running and maintaining it | 3: cost and speed of change | 12–16 |

---

### A. It matches against records that should never match

All 226 measured bad matches in the summary table come from this group.

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

#### 3. Duplicate bank-feed rows are matched as if they were real payments
The bank feed delivered the same payment twice: two rows on account `…0001` with
`remote_id = BNK-2026-000777`, rent of −€1,500 on 2026-12-01. The job matches **both** to the
same rent invoice (`LOYER-2026-12`). Nothing deduplicates on `(account_id, remote_id)`, and the
schema has no unique constraint on it.

**Consequence:** a feed glitch turns into a double-paid invoice in the books. The matcher should
catch this kind of upstream problem, not spread it further.

---

### B. When several invoices fit, it picks one anyway

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

---

### C. Amounts and dates are compared incorrectly

#### 6. Money is stored and compared as floating point
`real` holds only about 6–7 significant digits, and `tax_free_total + vat_amount === amount`
compares JavaScript floats exactly.

Measured: for **7,667 of 35,017 invoices (22%)**, `tax_free_total + vat_amount` in JavaScript is
not exactly the two-decimal total (e.g. `0.1 + 0.2 = 0.30000000000000004`). Those invoices can
never equal a transaction amount, so they are silently unmatchable.

**Consequence:** mostly missed matches today. For large amounts, `real` rounding can also make two
different values look equal, which produces a wrong match. Money needs `numeric(…,2)` or whole
cents (integer).

#### 7. Dates can be off by one day
`pg` turns the `date` column into a JavaScript Date at **local** midnight, while
`new Date("2026-08-16")` reads the `varchar` due date as **UTC** midnight. In Europe/Paris
(UTC+1 or +2) the difference picks up a few hours, and `Math.floor` turns that into a whole day.

**Consequence:** invoices right at the −3 or +30 day edge of the window are wrongly accepted or
rejected, and the result depends on the server's timezone and on daylight saving time.

#### 8. Invoices without a due date can never match
**1,051 invoices have a `NULL` `due_date`.** `new Date(null)` is 1970-01-01, so they fall outside
every date window. Nothing reports or counts them.

**Consequence:** silent missed matches. The customer just sees work left for them to do by hand,
with no explanation.

---

### D. Writes and failures are unsafe and invisible

#### 9. Writes are not safe or auditable
Each `update` stands alone: no database transaction, no `where matched_invoice_id is null` guard,
and no unique constraint on `matched_invoice_id`. Nothing records *why* a match was made (which
rule, what score, when, which run).

**Consequence:** two runs at the same time, or a run during a manual edit, race each other. A wrong
match can't be audited, explained to the customer, or reverted in bulk.

#### 10. Errors are swallowed
The `catch` block logs `skip` and continues. On the seed data, the invoice with a `NULL`
`supplier_name` makes `normalizeLabel` throw (`matcher.ts:35` → `:20`). The throw happens while
scoring all candidates, so the whole transaction goes unmatched even when another candidate was
valid. The same `catch` hides a lost database connection: during a Docker outage, the job printed
one `skip ECONNRESET` per transaction and still exited normally with a summary line.

**Consequence:** partial or failed runs look like successful ones, so monitoring never alerts.

#### 11. SQL injection
All four queries paste values into the SQL text. Today the inputs come from the code itself or the
database, but `companySiren` will come from an API or queue someday, and any value containing a
quote already breaks the query.

**Consequence:** easy to exploit once exposed, and the fix is trivial (`$1` parameters). It sits in
Tier 2 only because the README says wrong matches are the damage that matters most, and this one
isn't exposed yet.

---

### E. Running and maintaining it

#### 12. It's slow because of N+1 queries
About 1,200 transactions × one "all 35,017 invoices of the company" query each, so roughly
42 million rows are read for one small company, which takes **~49 s**.

**Consequence:** timeouts and heavy database load at real customer volumes. Load invoices once and
index them by amount, or do the amount and date filtering in SQL.

#### 13. The code has no structure to fix things in
Business rules, SQL and orchestration all live in one function, so none of the fixes above can be
tested without a database. See §3 for the detailed review.

**Consequence:** every Tier 1 fix is risky to ship and hard to prove correct.

#### 14. The schema enforces nothing
No foreign keys, no `NOT NULL`, no `CHECK` constraints or enums on statuses, no indexes, no
uniqueness on `(account_id, remote_id)` or invoice numbers, and `due_date` stored as `varchar`.

**Consequence:** bad data gets in quietly, and every consumer has to defend against it.

#### 15. No real tests
None of the rules above are covered. The only two tests check `normalizeLabel` and `dayDiff`.

**Consequence:** every fix to the Tier 1 problems carries regression risk.

#### 16. Smaller issues
- A missing company crashes with an unhelpful `TypeError`.
- The SIREN is hardcoded in `main.ts`.
- The magic numbers `-30`, `3` and `-100` aren't named.
- `select *` is used throughout.
- The TypeScript types claim fields can't be null when the data has nulls (`due_date`,
  `supplier_name`).

---

## 3. Code structure review

**Short answer: yes, it's under-structured, and that matters here.** It isn't about style. The
structure is why findings 1–8 went unnoticed and why they are hard to fix safely. It shouldn't
become a layered enterprise design either. For ~100 lines, three small pieces are enough.

### What's wrong today

`matcher.ts` is one file doing five jobs:

| Concern | Where it lives today | Problem |
|---|---|---|
| Data access | Inline SQL strings in `runAutoMatching` and `getCandidates` | Interpolated, `select *`, and it imports the global `db` pool directly |
| Eligibility rules (which records may match) | Missing. Never applied. | Findings 1–3 come from it not existing |
| Matching decision (filter, score, pick) | `findMatch` and `scoreCandidate`, not exported | Can't be unit-tested, and has no "ambiguous" outcome |
| Writing results | An `update` inside the loop | No transaction, no guard, no audit trail |
| Orchestration and reporting | `runAutoMatching`, with `try/catch` and `console.log` | Swallows errors and reports only a count |

The core problem is that **the decision logic isn't a pure function**. It's mixed with I/O, so you
can't write the test that matters most: "given these transactions and invoices, this is what gets
matched, this is left alone, and why".

### Is a repository missing?

Yes, but as a thin query module, not as a pattern for its own sake. Its value here is concrete:

1. **Testability.** The matcher can depend on an interface, and tests can use in-memory data
   instead of Postgres.
2. **One place for the eligibility rules in SQL.** "Open invoice", "outgoing, booked, not deleted,
   not yet matched transaction" and "not already claimed" get defined once, as parameterised
   queries, instead of being forgotten in each caller.
3. **Safe writes.** `recordMatches` can own the database transaction, the
   `where matched_invoice_id is null` guard and the audit row.

### Proposed shape

```
main.ts                  entry point: parse SIREN, run job, exit code ≠ 0 on failure
src/
  db.ts                  pool (unchanged)
  money.ts, dates.ts     cents as integers, date-only values (no Date/timezone)
  repository.ts          loadCompany, loadOpenTransactions, loadOpenInvoices,
                         recordMatches (one DB transaction, guarded)
  matching.ts            PURE: decide(transactions, invoices, config) →
                         { matched[], ambiguous[], noCandidate[] }, each with a reason
  job.ts                 orchestration: load → decide → write → report;
                         infrastructure errors stop the run
```

- `matching.ts` has no imports from `pg` or `db`. Rules are small functions (filters, then
  scorers), and thresholds live in a config object (window −3/+30, minimum confidence margin).
- The result type includes **ambiguous** and **no candidate** as first-class outcomes. That is the
  structural fix for finding 4: "unsure" becomes something the code can say.
- Tests: most coverage on `matching.ts` (fast, table-driven), plus a few integration tests of
  `repository.ts` against the Docker database.

### What I'd deliberately not add
No DI container, no service and manager classes, no generic `Repository<T>` base, no ORM. A
module of plain functions with typed inputs and outputs is enough at this size. Passing
dependencies in as parameters does the job of dependency injection.

### Mapped to SOLID, briefly
- **Single responsibility** and **dependency inversion** are the two that matter. The split above
  fixes both.
- **Open/closed** becomes cheap with rules as a list of functions.
- **Liskov substitution** and **interface segregation** barely apply to a procedural module this
  size. The only related issue is the row types claiming fields are non-null when the data has
  nulls.

---

## 4. Note: what's left undone, open product questions, next steps

_To be written after the rework._

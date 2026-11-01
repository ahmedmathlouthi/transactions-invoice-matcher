# Questions for product

Each question comes with the data that raised it and a proposal. Figures are from the seed data.

## Data entry and validation

1. **Are invoice and transaction statuses a closed list, and where is it enforced?**
   `invoice_status` and `transaction.status` are free `varchar` columns. Today the data holds only
   `Pending`, `ToPay`, `Paid` and `Cancelled` for invoices, and `Booked` and `Pending` for
   transactions, but nothing stops a typo like `paid` or `To Pay`, which the job would silently
   treat as "not payable". *Proposal:* validate in the app and add a `CHECK` constraint (cheaper to
   change later than a Postgres enum). Product owns the list and what each status means.

2. **Why do so many invoices have no due date, and should it be mandatory?**
   1,051 invoices have no `due_date`, all at company `900997767`, and 646 of them are still open,
   so they can never be matched (e.g. Acme Consulting `AC-0914`, €480, paid on 2026-09-14). Is it
   an import or OCR gap, a supplier that prints no due date, or an optional form field?
   *Proposal:* make it mandatory for new invoices, or default it from the issue date plus the
   supplier's payment terms (the schema has neither field today). Decide what to do with the
   existing 646: backfill, or match them on a wider rule and send them to review.

3. **What does `Paid` mean if nothing proves the payment?** 10,357 live invoices are `Paid`, and
   10,347 of them have no bank transaction linked. Is `Paid` set by hand, by another system, or by
   the matcher? *Proposal:* the matcher only considers `ToPay` and `Pending` today. Product should
   confirm that, and say whether a match should set the invoice to `Paid`, and whether a `Paid`
   invoice with no linked transaction should be flagged.

4. **Can required invoice fields be empty?** One invoice has an empty `invoice_number`, one has no
   `supplier_name`, and the schema doesn't make invoice numbers unique per supplier. *Proposal:*
   require both, and make `(company, supplier, invoice_number)` unique, which also catches
   invoices entered twice.

## How and when the job runs

5. **Is this run by a worker, and what triggers it?** Do transactions arrive by a bank webhook, a
   scheduled sync (like the Qonto worker, which pulls on a timer), or a file import? *Proposal:*
   one queued job per company, triggered when **either** new transactions **or** new invoices
   arrive (an invoice entered late should still match an old payment), with a uniqueness lock so a
   company never has two runs at once, plus a nightly run as a safety net.

6. **Who reads the review sheet, and through what channel?** The job now writes one CSV listing
   ambiguous transactions with every candidate invoice (149 transactions, 1,197 rows on the seed).
   Who owns it, how often, and by email, Slack or in the app? *Proposal:* start with the CSV, then
   read the `finance_choice` column back to record the chosen matches.

7. **Should there be a screen for manual matching?** Yes, in my view: the job deliberately leaves
   ambiguous transactions unmatched, and someone must resolve them. The screen should show the
   transaction with its candidate invoices (closest due date first), allow match, **unmatch**, and
   "none of these". *Proposal:* store who matched it and how (`auto` or `manual`) next to
   `matched_at`, so the job never overwrites a human decision and wrong auto-matches can be
   audited and undone. One match already exists in the seed (OVH SAS, €360); was it manual?

## Matching rules

8. **Recurring payments of the same amount to the same supplier.** In 144 of the 149 ambiguous
   cases, every candidate invoice comes from the same supplier: subscriptions, e.g. a Google Cloud
   payment of €112.80 with 5 open invoices of that amount within the window. Can we pay the oldest
   open invoice first? It would resolve almost all ambiguous cases, but it's a business rule, not
   a technical one.

9. **Is the window right?** Due date from 3 days before to 30 days after the payment. Do clients
   pay earlier than 3 days before the due date, or late by more than 30 days?

10. **Are amounts always exact?** Bank fees, early-payment discounts, partial payments, one
    transfer paying several invoices, or one invoice paid in instalments all fail an exact match
    today. Which of these matter to clients?

11. **Is everything in euros?** Neither table has a currency. If foreign suppliers exist, a
    transaction and an invoice must only be compared in the same currency.

12. **Incoming money.** 153 transactions are credits (refunds, supplier credit notes). Should they
    be matched against supplier credit notes, which the schema doesn't model yet?

## Duplicate transactions

13. **What do we do with duplicates?** There are two different cases, and they need different
    answers:
    - **Duplicate import:** the same bank movement stored twice (same account, same `remote_id`,
      e.g. `BNK-2026-000777`, rent €1,500). No money moved twice; it's our data bug. *Proposal:*
      prevent it at import with a unique key on `(account_id, remote_id)`, remove the extra row,
      and don't involve the client. The job already refuses to match these rows.
    - **Real double payment:** two different bank movements, e.g. `BNK-2026-000275` and
      `BNK-2026-001032`, both OVH SAS, €29.99, on 2026-12-17. This could be a real double debit
      or two separate subscriptions. *Proposal:* flag it to the client for confirmation. If it is
      a double payment, the client asks the **supplier** for a refund or a credit note: these are
      buying invoices, so the credit note comes from the supplier, not from us.

    Should we inform the client in both cases? I'd say only in the second: the first is ours to
    fix silently, the second is the client's money.

14. **The transaction with no account.** One transaction belongs to no known account, so it's
    invisible to every company. Is that an import error, or an account that was deleted?

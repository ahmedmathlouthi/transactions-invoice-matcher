-- When the job made the match. NULL on a matched row means it wasn't made by the job.
-- Adding a nullable column without a default is instant: no table rewrite, no data to move.
alter table transaction
  add column matched_at timestamptz;

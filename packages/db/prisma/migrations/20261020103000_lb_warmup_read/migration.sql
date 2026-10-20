-- Threads stored as closed were open: the reader matched a language string in a script.
-- off_topic_thread rows from the strict gate can be judged again.

DELETE FROM "lb_thread_candidates"
WHERE "rejectReason" = 'closed';

DELETE FROM "lb_thread_candidates"
WHERE "rejectReason" = 'off_topic_thread'
  AND "createdAt" >= TIMESTAMP '2026-10-20 00:00:00+00';

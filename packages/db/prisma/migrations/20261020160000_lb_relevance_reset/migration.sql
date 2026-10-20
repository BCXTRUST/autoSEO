-- R3 stored low-relevance scores were computed against one use case.
-- Rows written after this migration stay stored.
DELETE FROM "lb_thread_candidates"
WHERE "status" = 'rejected'
  AND "rejectReason" IN ('low_relevance', 'model_relevance');

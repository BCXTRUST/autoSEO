-- Warmup gate: drop the false "replies closed" rows from 19 Oct, put diabetes-forum.de
-- back on warming, keep reply bytes on the artifact row, and allow pending moderation.

DELETE FROM "lb_thread_candidates"
WHERE "status" = 'rejected'
  AND "rejectReason" = 'replies_closed'
  AND "createdAt" >= TIMESTAMP '2026-10-19 00:00:00';

UPDATE "lb_hosts"
SET "status" = 'warming', "parkedFrom" = NULL
WHERE "registrableDomain" = 'diabetes-forum.de'
  AND "projectId" = 'cmuwjtyeg00005xo5zgz70ls2'
  AND "status" = 'ready';

ALTER TABLE "artifacts" ADD COLUMN "content" BYTEA;

ALTER TABLE "lb_drafts" DROP CONSTRAINT "lb_drafts_status_check";

ALTER TABLE "lb_drafts" ADD CONSTRAINT "lb_drafts_status_check" CHECK ("status" IN ('drafted', 'approved', 'posted', 'pending_moderation', 'discarded'));

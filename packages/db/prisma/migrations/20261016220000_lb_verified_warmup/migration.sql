-- Verified restored accounts that are still short of warmup move qualified -> warming.
-- This is the account_active transition. Unverified logins stay qualified. No failed event.
UPDATE "lb_hosts" AS host
SET "status" = 'warming'
WHERE host."projectId" = 'cmuwjtyeg00005xo5zgz70ls2'
  AND host."status" = 'qualified'
  AND host."registrableDomain" IN ('diabetes-forum.de', 'med2-forum.de')
  AND EXISTS (
    SELECT 1
    FROM "lb_host_accounts" AS account
    WHERE account."hostId" = host."id"
      AND account."emailVerifiedAt" IS NOT NULL
      AND account."postCount" < 4
  );

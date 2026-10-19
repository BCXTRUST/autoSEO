-- A login-page error marked the verified accounts dead. Put them back on warming.
UPDATE "lb_hosts" AS host
SET "status" = 'warming',
    "statusReason" = NULL
WHERE host."projectId" = 'cmuwjtyeg00005xo5zgz70ls2'
  AND host."status" = 'dead'
  AND host."registrableDomain" IN ('diabetes-forum.de', 'med2-forum.de')
  AND EXISTS (
    SELECT 1
    FROM "lb_host_accounts" AS account
    WHERE account."hostId" = host."id"
      AND account."emailVerifiedAt" IS NOT NULL
  );

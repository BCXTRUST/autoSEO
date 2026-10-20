-- English and Croatian boards were stored as German. krank.de has no account to warm.
-- amsel.de is a German MS forum whose confirmation arrived and was never opened.

UPDATE "lb_hosts"
SET "status" = 'off_topic', "statusReason" = 'language:en', "language" = 'en'
WHERE "registrableDomain" = 'fitness.com';

UPDATE "lb_hosts"
SET "status" = 'off_topic', "statusReason" = 'language:hr', "language" = 'hr'
WHERE "registrableDomain" = 'fitness.com.hr';

UPDATE "lb_hosts"
SET "status" = 'dead', "statusReason" = 'orphan_account'
WHERE "registrableDomain" = 'krank.de' AND "status" = 'qualified';

UPDATE "lb_hosts"
SET "status" = 'pending_email', "statusReason" = NULL
WHERE "registrableDomain" = 'amsel.de' AND "status" = 'dead' AND "statusReason" = 'fetch_failed';

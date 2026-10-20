-- The confirmation page was opened, then an unknown result marked the host dead.
-- The activate button is still on the page, so the reader should try again.

UPDATE "lb_hosts"
SET "status" = 'pending_email', "statusReason" = NULL
WHERE "registrableDomain" = 'amsel.de' AND "status" = 'dead';

-- A missing signup form is retryable. Dead stays for a block, a closed registration, or a down site.
ALTER TABLE "lb_hosts" DROP CONSTRAINT "lb_hosts_status_check";

ALTER TABLE "lb_hosts" ADD CONSTRAINT "lb_hosts_status_check" CHECK ("status" IN ('discovered', 'probed', 'qualified', 'registering', 'pending_email', 'pending_admin', 'warming', 'ready', 'used', 'denied', 'spam_blocked', 'unsupported_captcha', 'parked_operator', 'form_not_found', 'dead'));

UPDATE "lb_hosts"
SET "status" = 'form_not_found'
WHERE "status" = 'dead' AND "statusReason" = 'no_signup_form';

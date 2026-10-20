-- An off-topic forum is not startable. Dead stays for a block, a closed registration, or a down site.
ALTER TABLE "lb_hosts" DROP CONSTRAINT "lb_hosts_status_check";

ALTER TABLE "lb_hosts" ADD CONSTRAINT "lb_hosts_status_check" CHECK ("status" IN ('discovered', 'probed', 'qualified', 'registering', 'pending_email', 'pending_admin', 'warming', 'ready', 'used', 'denied', 'spam_blocked', 'unsupported_captcha', 'parked_operator', 'form_not_found', 'off_topic', 'dead'));

-- Page text for these five restored hosts did not match the project lanes.
-- bmw-syndikat.de is a BMW and tuning forum. drwindows.de and nickles.de are Windows and software.
-- office-fragen.de is Microsoft Office. pickupforum.de is a pickup-artist community.
-- The other restored qualified hosts stay qualified.
UPDATE "lb_hosts"
SET "status" = 'off_topic', "statusReason" = 'off_topic'
WHERE "projectId" = 'cmuwjtyeg00005xo5zgz70ls2'
  AND "status" = 'qualified'
  AND "registrableDomain" IN (
    'bmw-syndikat.de',
    'drwindows.de',
    'nickles.de',
    'office-fragen.de',
    'pickupforum.de'
  );

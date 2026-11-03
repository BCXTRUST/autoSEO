CREATE TABLE "campaigns" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "clientNonce" TEXT NOT NULL,
  "config" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "mode" TEXT NOT NULL DEFAULT 'research',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "eventSequence" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "campaigns_status_check" CHECK ("status" IN ('draft', 'active', 'paused', 'archived')),
  CONSTRAINT "campaigns_mode_check" CHECK ("mode" IN ('research', 'controlled')),
  CONSTRAINT "campaigns_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "campaigns_eventSequence_check" CHECK ("eventSequence" >= 0)
);

CREATE TABLE "campaign_items" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "url" TEXT,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL,
  "details" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "campaign_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "campaign_items_kind_check" CHECK ("kind" IN ('source', 'opportunity', 'account', 'draft', 'publication')),
  CONSTRAINT "campaign_items_status_check" CHECK ("status" IN ('queued', 'researching', 'deferred', 'needs_action', 'ready', 'approved', 'submitted', 'verified', 'failed'))
);

CREATE TABLE "campaign_events" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "type" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "stepId" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "campaign_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "campaign_events_sequence_check" CHECK ("sequence" > 0),
  CONSTRAINT "campaign_events_summary_length_check" CHECK (length(trim("summary")) BETWEEN 1 AND 500)
);

CREATE TABLE "campaign_jobs" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "itemId" TEXT,
  "operation" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 3,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "heartbeatAt" TIMESTAMP(3),
  "deadlineAt" TIMESTAMP(3),
  "leaseExpiresAt" TIMESTAMP(3),
  "leaseOwner" TEXT,
  "leaseFence" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "checkpoint" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "campaign_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "campaign_jobs_status_check" CHECK ("status" IN ('queued', 'running', 'waiting_external', 'waiting_review', 'deferred', 'needs_action', 'reconciling', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT "campaign_jobs_attempts_check" CHECK ("attemptCount" >= 0 AND "maxAttempts" > 0),
  CONSTRAINT "campaign_jobs_leaseFence_check" CHECK ("leaseFence" >= 0)
);

CREATE TABLE "campaign_commands" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "nonce" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "result" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "campaign_commands_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "campaigns_workspaceId_userId_clientNonce_key"
  ON "campaigns"("workspaceId", "userId", "clientNonce");
CREATE INDEX "campaigns_workspaceId_userId_updatedAt_idx"
  ON "campaigns"("workspaceId", "userId", "updatedAt");
CREATE INDEX "campaign_items_campaignId_kind_status_createdAt_idx"
  ON "campaign_items"("campaignId", "kind", "status", "createdAt");
CREATE UNIQUE INDEX "campaign_events_campaignId_sequence_key"
  ON "campaign_events"("campaignId", "sequence");
CREATE INDEX "campaign_events_campaignId_occurredAt_idx"
  ON "campaign_events"("campaignId", "occurredAt");
CREATE INDEX "campaign_jobs_status_availableAt_createdAt_idx"
  ON "campaign_jobs"("status", "availableAt", "createdAt");
CREATE INDEX "campaign_jobs_status_leaseExpiresAt_idx"
  ON "campaign_jobs"("status", "leaseExpiresAt");
CREATE INDEX "campaign_jobs_campaignId_status_availableAt_idx"
  ON "campaign_jobs"("campaignId", "status", "availableAt");
CREATE UNIQUE INDEX "campaign_commands_campaignId_nonce_key"
  ON "campaign_commands"("campaignId", "nonce");
CREATE INDEX "campaign_commands_campaignId_createdAt_idx"
  ON "campaign_commands"("campaignId", "createdAt");

ALTER TABLE "campaigns"
  ADD CONSTRAINT "campaigns_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "campaigns"
  ADD CONSTRAINT "campaigns_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "campaign_items"
  ADD CONSTRAINT "campaign_items_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "campaign_events"
  ADD CONSTRAINT "campaign_events_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "campaign_jobs"
  ADD CONSTRAINT "campaign_jobs_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "campaign_jobs"
  ADD CONSTRAINT "campaign_jobs_itemId_fkey"
  FOREIGN KEY ("itemId") REFERENCES "campaign_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "campaign_commands"
  ADD CONSTRAINT "campaign_commands_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

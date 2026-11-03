CREATE TABLE "campaign_challenge_tasks" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "nonce" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'creating',
  "providerTaskId" TEXT,
  "reservationMicros" BIGINT NOT NULL,
  "actualCostMicros" BIGINT,
  "pollAttempts" INTEGER NOT NULL DEFAULT 0,
  "maxPollAttempts" INTEGER NOT NULL DEFAULT 12,
  "deadlineAt" TIMESTAMP(3) NOT NULL,
  "nextPollAt" TIMESTAMP(3),
  "pollLeaseUntil" TIMESTAMP(3),
  "safeError" TEXT,
  "solutionCiphertext" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "campaign_challenge_tasks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "campaign_challenge_tasks_status_check" CHECK ("status" IN ('creating', 'submitted', 'ready', 'failed', 'ambiguous')),
  CONSTRAINT "campaign_challenge_tasks_reservation_check" CHECK ("reservationMicros" >= 0),
  CONSTRAINT "campaign_challenge_tasks_actual_cost_check" CHECK ("actualCostMicros" IS NULL OR "actualCostMicros" >= 0),
  CONSTRAINT "campaign_challenge_tasks_poll_attempts_check" CHECK ("pollAttempts" >= 0 AND "maxPollAttempts" > 0)
);

CREATE UNIQUE INDEX "campaign_challenge_tasks_campaignId_nonce_key"
  ON "campaign_challenge_tasks"("campaignId", "nonce");
CREATE UNIQUE INDEX "campaign_challenge_tasks_providerTaskId_key"
  ON "campaign_challenge_tasks"("providerTaskId");
CREATE INDEX "campaign_challenge_tasks_campaignId_status_createdAt_idx"
  ON "campaign_challenge_tasks"("campaignId", "status", "createdAt");
CREATE INDEX "campaign_challenge_tasks_campaignId_createdAt_idx"
  ON "campaign_challenge_tasks"("campaignId", "createdAt");

ALTER TABLE "campaign_challenge_tasks"
  ADD CONSTRAINT "campaign_challenge_tasks_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

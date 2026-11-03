CREATE TABLE "campaign_publication_actions" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "draftId" TEXT NOT NULL,
  "nonce" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "topicId" INTEGER NOT NULL,
  "bodySnapshot" TEXT NOT NULL,
  "approvedDraftUpdatedAt" TIMESTAMP(3) NOT NULL,
  "contentHash" TEXT NOT NULL,
  "expectedLink" TEXT NOT NULL,
  "providerPostId" INTEGER,
  "publicUrl" TEXT,
  "safeError" TEXT,
  "verificationAttempts" INTEGER NOT NULL DEFAULT 0,
  "maxVerificationAttempts" INTEGER NOT NULL DEFAULT 12,
  "deadlineAt" TIMESTAMP(3) NOT NULL,
  "nextVerifyAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "campaign_publication_actions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "campaign_publication_actions_status_check" CHECK ("status" IN ('intent', 'submitted', 'pending', 'verified', 'ambiguous', 'blocked', 'failed')),
  CONSTRAINT "campaign_publication_actions_topicId_check" CHECK ("topicId" > 0),
  CONSTRAINT "campaign_publication_actions_providerPostId_check" CHECK ("providerPostId" IS NULL OR "providerPostId" > 0),
  CONSTRAINT "campaign_publication_actions_attempts_check" CHECK ("verificationAttempts" >= 0 AND "maxVerificationAttempts" > 0)
);

CREATE UNIQUE INDEX "campaign_publication_actions_campaignId_nonce_key"
  ON "campaign_publication_actions"("campaignId", "nonce");
CREATE INDEX "campaign_publication_actions_campaignId_status_createdAt_idx"
  ON "campaign_publication_actions"("campaignId", "status", "createdAt");
CREATE INDEX "campaign_publication_actions_status_nextVerifyAt_idx"
  ON "campaign_publication_actions"("status", "nextVerifyAt");

ALTER TABLE "campaign_publication_actions"
  ADD CONSTRAINT "campaign_publication_actions_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "campaign_publication_actions"
  ADD CONSTRAINT "campaign_publication_actions_draftId_fkey"
  FOREIGN KEY ("draftId") REFERENCES "campaign_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

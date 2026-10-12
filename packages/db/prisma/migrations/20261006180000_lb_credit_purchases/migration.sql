CREATE TABLE "lb_credit_purchases" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "billing" TEXT NOT NULL,
    "chargeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lb_credit_purchases_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "lb_credit_purchases_workspaceId_createdAt_idx" ON "lb_credit_purchases"("workspaceId", "createdAt");

CREATE UNIQUE INDEX "lb_credit_purchases_chargeId_key" ON "lb_credit_purchases"("chargeId");

ALTER TABLE "lb_credit_purchases" ADD CONSTRAINT "lb_credit_purchases_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lb_credit_purchases" ADD CONSTRAINT "lb_credit_purchases_billing_check" CHECK (
    ("billing" = 'live' AND "chargeId" IS NOT NULL AND char_length("chargeId") > 0 AND "credits" > 0)
    OR
    ("billing" = 'allowance' AND "chargeId" IS NULL AND "credits" = 0)
);

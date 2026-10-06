-- 034 — PL4Y is unregistered for GST (decided 2026-10-03). A player pays
-- exactly the entry fee; PL4Y's income is the 10% host commission.

-- New categories carry no tax.
ALTER TABLE "event_categories" ALTER COLUMN "tax_bps" SET DEFAULT 0;

-- Draws still taking entries stop adding GST now. Players already paid keep
-- what they paid (their payments and refunds read the order, not this
-- column); a player part-way through paying is told the price changed and
-- registers again at the lower price (gap #12).
UPDATE "event_categories" SET "tax_bps" = 0 WHERE "status" IN ('open', 'full');

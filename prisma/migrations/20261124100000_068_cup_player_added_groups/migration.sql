-- 068 — Cup entry, founder ask 2026-11-24: a player picks their college (the
-- campus ambassador code is optional) and, when it isn't listed, types it in.
-- A college a player typed in records who added it, so staff can spot it in
-- the portal and rename, merge or hide it. Null = added by staff.
ALTER TABLE "competition_groups"
    ADD COLUMN "added_by_user_id" UUID REFERENCES "users"("id") ON DELETE SET NULL;

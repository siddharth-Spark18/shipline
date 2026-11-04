-- Chat-first workspace (revision 2026-10-28 b).
-- Dev data reset: tickets are re-created from chats, so every ticket (and, by cascade, its stage
-- runs, artifacts, transitions, tool decisions, overrides, PRs and audit rows) is dropped first.
TRUNCATE TABLE "Ticket" CASCADE;

-- AlterEnum
BEGIN;
CREATE TYPE "StageStatus_new" AS ENUM ('PENDING', 'IN_PROGRESS', 'DONE', 'SKIPPED');
ALTER TABLE "StageRun" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "StageRun" ALTER COLUMN "status" TYPE "StageStatus_new" USING ("status"::text::"StageStatus_new");
ALTER TYPE "StageStatus" RENAME TO "StageStatus_old";
ALTER TYPE "StageStatus_new" RENAME TO "StageStatus";
DROP TYPE "StageStatus_old";
ALTER TABLE "StageRun" ALTER COLUMN "status" SET DEFAULT 'PENDING';
COMMIT;

-- DropForeignKey
ALTER TABLE "Ticket" DROP CONSTRAINT "Ticket_assigneeId_fkey";

-- DropIndex
DROP INDEX "Ticket_assigneeId_idx";

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "keyPrefix" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "ticketCounter" INTEGER NOT NULL DEFAULT 0;

-- OPEN-QUESTION: the backfilled prefix is the first 3 letters/digits of the name (Learnloop -> LEA); the seed sets LL.
-- Existing projects get a prefix from their name; an admin can change it in project settings.
UPDATE "Project" SET "keyPrefix" = COALESCE(NULLIF(UPPER(LEFT(REGEXP_REPLACE("name", '[^A-Za-z0-9]', '', 'g'), 3)), ''), 'PRJ');
ALTER TABLE "Project" ALTER COLUMN "keyPrefix" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Ticket" DROP COLUMN "assigneeId",
DROP COLUMN "jiraAssigneeEmail",
DROP COLUMN "jiraAssigneeName",
DROP COLUMN "orphaned",
DROP COLUMN "summary",
ADD COLUMN     "jiraSummary" TEXT,
ADD COLUMN     "key" TEXT NOT NULL,
ADD COLUMN     "ownerId" TEXT NOT NULL,
ADD COLUMN     "title" TEXT NOT NULL,
ALTER COLUMN "jiraKey" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "Ticket_ownerId_idx" ON "Ticket"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_projectId_key_key" ON "Ticket"("projectId", "key");

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


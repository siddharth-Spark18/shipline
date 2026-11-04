-- CreateEnum
CREATE TYPE "TransitionKind" AS ENUM ('COMPLETE', 'SKIP', 'REOPEN');

-- CreateEnum
CREATE TYPE "TransitionProposer" AS ENUM ('CLAUDE', 'USER');

-- CreateEnum
CREATE TYPE "TransitionDecision" AS ENUM ('PENDING', 'CONFIRMED', 'DECLINED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "PrState" AS ENUM ('OPEN', 'CLOSED', 'MERGED');

-- CreateEnum
CREATE TYPE "PrCommentKind" AS ENUM ('REVIEW', 'REVIEW_COMMENT');

-- AlterEnum
BEGIN;
CREATE TYPE "StageStatus_new" AS ENUM ('PENDING', 'IN_PROGRESS', 'DONE', 'SKIPPED', 'BLOCKED');
ALTER TABLE "StageRun" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "StageRun" ALTER COLUMN "status" TYPE "StageStatus_new" USING ("status"::text::"StageStatus_new");
ALTER TYPE "StageStatus" RENAME TO "StageStatus_old";
ALTER TYPE "StageStatus_new" RENAME TO "StageStatus";
DROP TYPE "StageStatus_old";
ALTER TABLE "StageRun" ALTER COLUMN "status" SET DEFAULT 'PENDING';
COMMIT;

-- DropForeignKey
ALTER TABLE "StageRun" DROP CONSTRAINT "StageRun_assigneeId_fkey";

-- DropForeignKey
ALTER TABLE "StageRun" DROP CONSTRAINT "StageRun_approverOverrideId_fkey";

-- DropForeignKey
ALTER TABLE "Approval" DROP CONSTRAINT "Approval_stageRunId_fkey";

-- DropForeignKey
ALTER TABLE "Approval" DROP CONSTRAINT "Approval_byId_fkey";

-- AlterTable
ALTER TABLE "Project" DROP COLUMN "allowSelfApproval",
DROP COLUMN "skipRoles",
ADD COLUMN     "baseBranch" TEXT NOT NULL DEFAULT 'main';

-- AlterTable
ALTER TABLE "StageDefinition" DROP COLUMN "approverRole",
DROP COLUMN "ownerRole",
ADD COLUMN     "allowedRoles" "Role"[];

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "assigneeId" TEXT,
ADD COLUMN     "branch" TEXT,
ADD COLUMN     "claudeSessionId" TEXT,
ADD COLUMN     "jiraAssigneeEmail" TEXT,
ADD COLUMN     "jiraAssigneeName" TEXT,
ADD COLUMN     "prNumber" INTEGER,
ADD COLUMN     "prState" "PrState",
ADD COLUMN     "worktreePath" TEXT;

-- AlterTable
ALTER TABLE "StageRun" DROP COLUMN "approverOverrideId",
DROP COLUMN "assigneeId",
DROP COLUMN "claudeSessionId",
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "reopenedCount" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE "PullRequest" ADD COLUMN     "htmlUrl" TEXT,
ADD COLUMN     "mergedAt" TIMESTAMP(3),
ADD COLUMN     "state" "PrState" NOT NULL DEFAULT 'OPEN';

-- DropTable
DROP TABLE "Approval";

-- DropEnum
DROP TYPE "ApprovalDecision";

-- CreateTable
CREATE TABLE "StageTransition" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "stageRunId" TEXT NOT NULL,
    "kind" "TransitionKind" NOT NULL,
    "targetStageKey" TEXT,
    "proposedBy" "TransitionProposer" NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "decision" "TransitionDecision" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,

    CONSTRAINT "StageTransition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrComment" (
    "id" TEXT NOT NULL,
    "pullRequestId" TEXT NOT NULL,
    "kind" "PrCommentKind" NOT NULL,
    "githubId" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "path" TEXT,
    "line" INTEGER,
    "reviewState" TEXT,
    "outdated" BOOLEAN NOT NULL DEFAULT false,
    "htmlUrl" TEXT,
    "commitId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "sentToClaudeAt" TIMESTAMP(3),

    CONSTRAINT "PrComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StageTransition_ticketId_decision_idx" ON "StageTransition"("ticketId", "decision");

-- CreateIndex
CREATE UNIQUE INDEX "PrComment_pullRequestId_kind_githubId_key" ON "PrComment"("pullRequestId", "kind", "githubId");

-- CreateIndex
CREATE INDEX "Ticket_assigneeId_idx" ON "Ticket"("assigneeId");

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StageTransition" ADD CONSTRAINT "StageTransition_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StageTransition" ADD CONSTRAINT "StageTransition_stageRunId_fkey" FOREIGN KEY ("stageRunId") REFERENCES "StageRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StageTransition" ADD CONSTRAINT "StageTransition_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrComment" ADD CONSTRAINT "PrComment_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;


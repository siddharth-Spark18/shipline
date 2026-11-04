-- Guardrails and workflow templates (docs/plans/shipline-guardrails-templates.md).
-- Generated with `prisma migrate diff`, then edited by hand so existing data is kept instead of reset:
-- the built-in Feature and Hotfix templates become version 1 of the new template library, existing
-- stage definitions move onto that version, existing chats are pinned to it, and every project gets
-- both templates enabled (Feature as its default).

-- CreateEnum
CREATE TYPE "GuardrailScope" AS ENUM ('ORG', 'PROJECT', 'ROLE');

-- CreateEnum
CREATE TYPE "GuardrailKind" AS ENUM ('PATH', 'BASH', 'TOOL');

-- CreateEnum
CREATE TYPE "RuleEffect" AS ENUM ('ALLOW', 'ASK', 'DENY');

-- CreateEnum
CREATE TYPE "RuleAction" AS ENUM ('READ', 'EDIT');

-- CreateTable
CREATE TABLE "WorkflowTemplateVersion" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowTemplateVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectTemplate" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ProjectTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuardrailRule" (
    "id" TEXT NOT NULL,
    "scope" "GuardrailScope" NOT NULL,
    "projectId" TEXT,
    "role" "Role",
    "kind" "GuardrailKind" NOT NULL,
    "pattern" TEXT NOT NULL,
    "actions" "RuleAction"[],
    "effect" "RuleEffect" NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuardrailRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomAgent" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "tools" TEXT[],
    "model" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomAgent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TemplateSwitch" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "toVersionId" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "decision" "TransitionDecision" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,

    CONSTRAINT "TemplateSwitch_pkey" PRIMARY KEY ("id")
);

-- WorkflowTemplate: from a key enum to a named, archivable, versioned template. The existing rows
-- (Feature, Hotfix) are the built-in templates.
ALTER TABLE "WorkflowTemplate" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "builtIn" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "description" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "WorkflowTemplate" ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "WorkflowTemplate" ALTER COLUMN "builtIn" SET DEFAULT false;

UPDATE "WorkflowTemplate" SET "description" = 'Research, plan, wireframes, build, QA, self-review and a pull request.' WHERE "key" = 'FEATURE';
UPDATE "WorkflowTemplate" SET "description" = 'Build the minimal fix, self-review and raise the PR. QA happens afterwards.' WHERE "key" = 'HOTFIX';

-- Every existing template becomes version 1 of itself.
INSERT INTO "WorkflowTemplateVersion" ("id", "templateId", "version", "name", "description")
SELECT 'ver_' || "id", "id", 1, "name", "description" FROM "WorkflowTemplate";

-- Projects keep offering what they had: both templates enabled, Feature preselected.
INSERT INTO "ProjectTemplate" ("id", "projectId", "templateId", "isDefault")
SELECT 'pt_' || md5(random()::text || clock_timestamp()::text || p."id" || t."id"), p."id", t."id", (t."key" = 'FEATURE')
FROM "Project" p CROSS JOIN "WorkflowTemplate" t;

-- StageDefinition: from a template to a template version, with a stage type, agent and stage rules.
ALTER TABLE "StageDefinition" ADD COLUMN     "agentName" TEXT,
ADD COLUMN     "agentRef" TEXT,
ADD COLUMN     "stageRules" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'custom',
ADD COLUMN     "versionId" TEXT;
-- The old keys are exactly the built-in stage types.
UPDATE "StageDefinition" SET "versionId" = 'ver_' || "templateId",
  "type" = CASE WHEN "key" IN ('research', 'plan', 'wireframes', 'build', 'qa', 'self_review', 'raise_pr', 'resolve_comments') THEN "key" ELSE 'custom' END;
ALTER TABLE "StageDefinition" ALTER COLUMN "versionId" SET NOT NULL;
ALTER TABLE "StageDefinition" DROP CONSTRAINT "StageDefinition_templateId_fkey";
DROP INDEX "StageDefinition_templateId_key_key";
ALTER TABLE "StageDefinition" DROP COLUMN "templateId";

-- Ticket: pinned to a template version (existing chats point at version 1).
ALTER TABLE "Ticket" ADD COLUMN     "templateVersionId" TEXT;
UPDATE "Ticket" SET "templateVersionId" = 'ver_' || "templateId";
ALTER TABLE "Ticket" ALTER COLUMN "templateVersionId" SET NOT NULL;
ALTER TABLE "Ticket" DROP CONSTRAINT "Ticket_templateId_fkey";
ALTER TABLE "Ticket" DROP COLUMN "templateId";

-- WorkflowTemplate: drop the key enum.
DROP INDEX "WorkflowTemplate_key_key";
ALTER TABLE "WorkflowTemplate" DROP COLUMN "key";

-- DropEnum
DROP TYPE "TemplateKey";

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowTemplateVersion_templateId_version_key" ON "WorkflowTemplateVersion"("templateId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectTemplate_projectId_templateId_key" ON "ProjectTemplate"("projectId", "templateId");

-- CreateIndex
CREATE INDEX "GuardrailRule_scope_projectId_idx" ON "GuardrailRule"("scope", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomAgent_name_key" ON "CustomAgent"("name");

-- CreateIndex
CREATE INDEX "TemplateSwitch_ticketId_decision_idx" ON "TemplateSwitch"("ticketId", "decision");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowTemplate_name_key" ON "WorkflowTemplate"("name");

-- CreateIndex
CREATE UNIQUE INDEX "StageDefinition_versionId_key_key" ON "StageDefinition"("versionId", "key");

-- AddForeignKey
ALTER TABLE "WorkflowTemplateVersion" ADD CONSTRAINT "WorkflowTemplateVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "WorkflowTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowTemplateVersion" ADD CONSTRAINT "WorkflowTemplateVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StageDefinition" ADD CONSTRAINT "StageDefinition_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "WorkflowTemplateVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectTemplate" ADD CONSTRAINT "ProjectTemplate_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectTemplate" ADD CONSTRAINT "ProjectTemplate_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "WorkflowTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuardrailRule" ADD CONSTRAINT "GuardrailRule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuardrailRule" ADD CONSTRAINT "GuardrailRule_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomAgent" ADD CONSTRAINT "CustomAgent_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "WorkflowTemplateVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemplateSwitch" ADD CONSTRAINT "TemplateSwitch_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemplateSwitch" ADD CONSTRAINT "TemplateSwitch_toVersionId_fkey" FOREIGN KEY ("toVersionId") REFERENCES "WorkflowTemplateVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemplateSwitch" ADD CONSTRAINT "TemplateSwitch_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

import { Artifact, ArtifactType, Project, StageDefinition } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { getDefaultBranch, putRepoFile } from '../lib/github-app';
import { getArtifactContent } from '../lib/artifact-storage';

const EXT: Record<ArtifactType, string> = {
  MARKDOWN: 'md',
  HTML: 'html',
  FIGMA_LINK: 'md',
  QA_REPORT: 'md',
  PR_LINK: 'md',
};

/**
 * When `commitArtifactsToRepo` is on, a finished stage's latest artifact is also committed to the repo.
 * Shipline stays the source of truth; failures are logged, never blocking the stage change.
 * OPEN-QUESTION #9: path and branch come from per-project settings (artifactRepoPath/artifactBranch).
 */
export async function commitDoneArtifact(
  project: Project,
  jiraKey: string,
  stageDef: StageDefinition,
  artifact: Artifact,
): Promise<void> {
  if (!project.commitArtifactsToRepo) return;
  try {
    const branch = project.artifactBranch ?? (await getDefaultBranch(project));
    const base = project.artifactRepoPath.replace(/^\/|\/$/g, '');
    const path = `${base}/${jiraKey}/${stageDef.key}-v${artifact.version}.${EXT[artifact.type]}`;
    const body =
      artifact.type === 'FIGMA_LINK' || artifact.type === 'PR_LINK'
        ? `${getArtifactContent(artifact)}\n`
        : getArtifactContent(artifact);
    await putRepoFile(project, path, body, `shipline: ${jiraKey} ${stageDef.name} v${artifact.version}`, branch);
    await prisma.artifact.update({ where: { id: artifact.id }, data: { committedPath: path } });
  } catch (err) {
    console.error(`Failed to commit artifact ${artifact.id} to repo:`, err);
  }
}

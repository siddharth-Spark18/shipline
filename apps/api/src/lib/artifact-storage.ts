import { env } from './env';
import { HttpError } from './http-error';

/**
 * OPEN-QUESTION #7: artifacts live in Postgres (`Artifact.content`) for v1. All reads and writes
 * go through this module so object storage can replace it later (use `Artifact.storageRef`)
 * without touching callers. The size limit is configurable via MAX_ARTIFACT_BYTES.
 */
export interface StoredContent {
  content: string | null;
  storageRef: string | null;
}

export function putArtifactContent(content: string): StoredContent {
  if (Buffer.byteLength(content, 'utf8') > env.maxArtifactBytes) {
    throw new HttpError(413, `Artifact exceeds the ${env.maxArtifactBytes}-byte limit`, 'ARTIFACT_TOO_LARGE');
  }
  return { content, storageRef: null };
}

export function getArtifactContent(artifact: { content: string | null; storageRef: string | null }): string {
  // OPEN-QUESTION #7: when object storage exists, resolve `storageRef` here.
  return artifact.content ?? '';
}

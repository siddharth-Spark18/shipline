/** Something the right panel's asset viewer can open. */
export type AssetRef =
  | {
      /** A file inside the ticket worktree, read through the local service. */
      source: 'worktree';
      /** Absolute or worktree-relative path. */
      path: string;
      name: string;
    }
  | {
      /** An artifact Claude submitted to Shipline: its content is already in the chat stream. */
      source: 'inline';
      name: string;
      type: 'MARKDOWN' | 'HTML' | 'QA_REPORT';
      content: string;
    };

export const assetKey = (a: AssetRef): string => (a.source === 'worktree' ? `w:${a.path}` : `i:${a.name}:${a.content.length}`);

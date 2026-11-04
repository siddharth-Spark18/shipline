import fs from 'fs';
import path from 'path';
import { AssetContentDTO, AssetKind, AssetMetaDTO } from '@shipline/shared';

export class AssetError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const TEXT_LIMIT = 2 * 1024 * 1024;
const IMAGE_LIMIT = 10 * 1024 * 1024;

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};
const TEXT_EXT = new Set([
  '.txt', '.json', '.yml', '.yaml', '.toml', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.scss',
  '.py', '.go', '.rs', '.java', '.rb', '.sh', '.sql', '.prisma', '.env', '.csv', '.xml', '.log',
]);

function classify(file: string): { kind: AssetKind; mime: string } {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return { kind: 'markdown', mime: 'text/markdown' };
  if (ext === '.html' || ext === '.htm') return { kind: 'html', mime: 'text/html' };
  if (IMAGE_MIME[ext]) return { kind: 'image', mime: IMAGE_MIME[ext] };
  if (TEXT_EXT.has(ext)) return { kind: 'text', mime: 'text/plain' };
  return { kind: 'other', mime: 'application/octet-stream' };
}

/** Resolves a requested path (absolute or relative) to a real file inside the worktree, or throws. */
export function resolveInsideWorktree(worktree: string, requested: string): string {
  const root = fs.realpathSync(worktree);
  let real: string;
  try {
    real = fs.realpathSync(path.resolve(root, requested));
  } catch {
    throw new AssetError(404, 'File not found');
  }
  const rel = path.relative(root, real);
  // Symlinks are resolved first, so a link pointing outside the worktree is rejected too.
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new AssetError(403, 'Assets can only be read from inside the ticket worktree');
  }
  return real;
}

export function readAssetMeta(worktree: string, requested: string): AssetMetaDTO {
  const real = resolveInsideWorktree(worktree, requested);
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new AssetError(400, 'Not a file');
  return {
    path: path.relative(fs.realpathSync(worktree), real),
    name: path.basename(real),
    kind: classify(real).kind,
    size: stat.size,
  };
}

export function readAsset(worktree: string, requested: string): AssetContentDTO {
  const meta = readAssetMeta(worktree, requested);
  const real = resolveInsideWorktree(worktree, requested);
  const { kind, mime } = classify(real);
  const base = { ...meta, mime, absolutePath: real, content: null, base64: null };
  if (kind === 'other') return base;
  const limit = kind === 'image' ? IMAGE_LIMIT : TEXT_LIMIT;
  if (meta.size > limit) throw new AssetError(413, `File is larger than ${Math.round(limit / 1024 / 1024)} MB`);
  const buf = fs.readFileSync(real);
  return kind === 'image' ? { ...base, base64: buf.toString('base64') } : { ...base, content: buf.toString('utf8') };
}

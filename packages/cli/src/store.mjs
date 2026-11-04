// The task store outside the repo ($SHIPLINE_HOME/projects/<encoded repo path>/). The helpers live in the
// vendored lib.mjs template (the hooks must stay dependency-free); the CLI and UI reuse that one copy so the
// path encoding is defined once. Node 18+, no dependencies.
import path from 'node:path';
import { encodePath, shiplineHome, storeDir, tasksDir, stateDir, safeId } from '../templates/shipline/bin/lib.mjs';

export { encodePath, shiplineHome, storeDir, tasksDir, stateDir, safeId };

// <store>/ui/: sessions.json, lock.json, mcp-<id>.json, ui.log and tmp/.
export const uiDir = (root) => path.join(storeDir(root), 'ui');

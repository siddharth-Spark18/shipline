// Opens the UI in the default browser. Node 20+, no dependencies.
import { spawn } from 'node:child_process';

export function openBrowser(url) {
  const win = process.platform === 'win32';
  const cmd = win
    ? 'cmd'
    : process.platform === 'darwin'
      ? 'open'
      : process.platform === 'linux'
        ? 'xdg-open'
        : null;
  const fallback = () => console.log(`Open ${url} in your browser`);
  if (!cmd) return fallback();
  try {
    const child = win
      ? spawn(cmd, ['/c', 'start', '""', url.replace(/&/g, '^&')], {
          stdio: 'ignore',
          windowsHide: true,
          windowsVerbatimArguments: true,
        })
      : spawn(cmd, [url], { detached: true, stdio: 'ignore' });
    child.on('error', fallback);
    child.on('exit', (code) => {
      if (code) fallback();
    });
    child.unref();
  } catch {
    fallback();
  }
}

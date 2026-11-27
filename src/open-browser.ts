import { spawn } from 'node:child_process';
// openExternal attempts to launch the system browser cross-platform.
export function openExternal(url: string, platform: NodeJS.Platform = process.platform, launch: typeof spawn = spawn) {
  const stdio = 'ignore';
  try {
    if (platform === 'darwin') {
      const child = launch('open', [url], { stdio, detached: true });
      child.on('error', () => {}); // swallow ENOENT when `open` is missing
      child.unref();
    } else if (platform === 'win32') {
      // Shell-free: do not pass the OAuth URL through cmd.exe. Command metacharacters
      // such as `&` in query strings are still parsed by cmd even when argv is split.
      // rundll32 FileProtocolHandler treats the URL as a document path, not command text.
      const child = launch('rundll32', ['url.dll,FileProtocolHandler', url], {
        stdio,
        detached: true,
        windowsHide: true,
      });
      child.on('error', () => {}); // swallow ENOENT when rundll32 is missing
      child.unref();
    } else {
      try {
        const child = launch('xdg-open', [url], { stdio, detached: true });
        child.on('error', () => {}); // swallow ENOENT on headless servers
        child.unref();
      } catch {
        // headless server — no browser available
      }
    }
  } catch {
    // best-effort: fall back to printing URL
  }
}

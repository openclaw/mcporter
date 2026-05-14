import fs from 'node:fs';
import path from 'node:path';

const MARKER = 'MCPORTER_DEVTOOLS_TIMEOUT_PATCH';
const HELPER = `// ${MARKER}
const MCPORTER_DEVTOOLS_DETECTION_TIMEOUT = 1_000;
async function mcporterWithTimeout(promise, fallback) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise(resolve => {
                timer = setTimeout(resolve, MCPORTER_DEVTOOLS_DETECTION_TIMEOUT, fallback);
                timer.unref?.();
            }),
        ]);
    }
    finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}
`;

const DETECTION_BLOCK = `if (await page.hasDevTools()) {
                    mcpPage.devToolsPage = await page.openDevTools();
                }`;

const PATCHED_DETECTION_BLOCK = `if (await mcporterWithTimeout(page.hasDevTools(), false)) {
                    mcpPage.devToolsPage = await mcporterWithTimeout(page.openDevTools(), undefined);
                }`;

patchChromeDevtoolsMcp();

export function patchChromeDevtoolsMcp(mainPath = process.argv[1]): void {
  if (!mainPath || !mainPath.includes('chrome-devtools-mcp')) {
    return;
  }
  let resolvedMainPath: string;
  try {
    resolvedMainPath = fs.realpathSync(mainPath);
  } catch {
    return;
  }
  if (!resolvedMainPath.endsWith(path.join('bin', 'chrome-devtools-mcp.js'))) {
    return;
  }
  const contextPath = path.resolve(path.dirname(resolvedMainPath), '..', 'McpContext.js');
  let source: string;
  try {
    source = fs.readFileSync(contextPath, 'utf8');
  } catch {
    return;
  }
  if (source.includes(MARKER)) {
    return;
  }
  if (!source.includes(DETECTION_BLOCK)) {
    return;
  }
  const withHelper = source.replace(
    'const NAVIGATION_TIMEOUT = 10_000;\n',
    `const NAVIGATION_TIMEOUT = 10_000;\n${HELPER}`
  );
  const patched = withHelper.replace(DETECTION_BLOCK, PATCHED_DETECTION_BLOCK);
  try {
    fs.writeFileSync(contextPath, patched);
  } catch {
    return;
  }
}

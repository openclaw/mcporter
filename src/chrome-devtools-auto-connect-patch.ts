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

interface PatchFileSystem {
  realpathSync(filePath: string): string;
  readFileSync(filePath: string, encoding: 'utf8'): string;
  writeFileSync(filePath: string, contents: string): void;
}

interface PatchPath {
  dirname(filePath: string): string;
  join(...paths: string[]): string;
  resolve(...paths: string[]): string;
}

patchChromeDevtoolsMcp();

export function patchChromeDevtoolsMcp(mainPath = process.argv[1]): void {
  patchChromeDevtoolsMcpWithDependencies(mainPath, fs, path, MARKER, HELPER, DETECTION_BLOCK, PATCHED_DETECTION_BLOCK);
}

export function renderChromeDevtoolsAutoConnectPatchSource(): string {
  return `import fs from 'node:fs';
import path from 'node:path';

const patchChromeDevtoolsMcp = ${patchChromeDevtoolsMcpWithDependencies.toString()};

patchChromeDevtoolsMcp(
  process.argv[1],
  fs,
  path,
  ${JSON.stringify(MARKER)},
  ${JSON.stringify(HELPER)},
  ${JSON.stringify(DETECTION_BLOCK)},
  ${JSON.stringify(PATCHED_DETECTION_BLOCK)}
);
`;
}

function patchChromeDevtoolsMcpWithDependencies(
  mainPath: string | undefined,
  fsApi: PatchFileSystem,
  pathApi: PatchPath,
  marker: string,
  helper: string,
  detectionBlock: string,
  patchedDetectionBlock: string
): void {
  if (!mainPath || !mainPath.includes('chrome-devtools-mcp')) {
    return;
  }
  let resolvedMainPath: string;
  try {
    resolvedMainPath = fsApi.realpathSync(mainPath);
  } catch {
    return;
  }
  if (!resolvedMainPath.endsWith(pathApi.join('bin', 'chrome-devtools-mcp.js'))) {
    return;
  }
  const contextPath = pathApi.resolve(pathApi.dirname(resolvedMainPath), '..', 'McpContext.js');
  let source: string;
  try {
    source = fsApi.readFileSync(contextPath, 'utf8');
  } catch {
    return;
  }
  if (source.includes(marker)) {
    return;
  }
  if (!source.includes(detectionBlock)) {
    return;
  }
  const withHelper = source.replace(
    'const NAVIGATION_TIMEOUT = 10_000;\n',
    `const NAVIGATION_TIMEOUT = 10_000;\n${helper}`
  );
  const patched = withHelper.replace(detectionBlock, patchedDetectionBlock);
  try {
    fsApi.writeFileSync(contextPath, patched);
  } catch {
    return;
  }
}

import fs from 'node:fs';
import path from 'node:path';
import type { CallResult } from '../result-utils.js';

export function saveCallImagesIfRequested<T>(wrapped: CallResult<T>, outputDir: string | undefined): void {
  if (!outputDir) {
    return;
  }
  const images = wrapped.images();
  if (!images || images.length === 0) {
    return;
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const writtenPaths: string[] = [];
  const timestamp = Date.now();
  for (const [index, image] of images.entries()) {
    const extension = extensionFromMimeType(image.mimeType);
    const baseName = `mcp-image-${timestamp}-${index + 1}`;
    const outputPath = resolveImageOutputPath(outputDir, baseName, extension);
    fs.writeFileSync(outputPath, Buffer.from(image.data, 'base64'));
    writtenPaths.push(outputPath);
  }

  for (const outputPath of writtenPaths) {
    console.error(`[mcporter] Saved image: ${outputPath}`);
  }
}

function extensionFromMimeType(mimeType: string | undefined): string {
  if (!mimeType) {
    return '.bin';
  }
  const normalized = mimeType.toLowerCase().split(';', 1)[0]?.trim() ?? '';
  const mapping: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
    'image/bmp': '.bmp',
    'image/tiff': '.tiff',
    'image/x-icon': '.ico',
  };
  return mapping[normalized] ?? '.bin';
}

function resolveImageOutputPath(outputDir: string, baseName: string, extension: string): string {
  let candidate = path.join(outputDir, `${baseName}${extension}`);
  if (!fs.existsSync(candidate)) {
    return candidate;
  }
  let suffix = 2;
  while (true) {
    candidate = path.join(outputDir, `${baseName}-${suffix}${extension}`);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
    suffix += 1;
  }
}

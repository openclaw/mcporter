import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { saveCallImagesIfRequested } from '../src/cli/image-output.js';
import { printCallOutput } from '../src/cli/output-utils.js';
import { createCallResult } from '../src/result-utils.js';

describe('saveCallImagesIfRequested', () => {
  it('does nothing when no output directory is provided', () => {
    const wrapped = createCallResult({
      content: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }],
    });
    const writeSpy = vi.spyOn(fs, 'writeFileSync');
    try {
      saveCallImagesIfRequested(wrapped, undefined);
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('saves image content blocks to the requested directory', () => {
    const wrapped = createCallResult({
      content: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }],
    });
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcporter-images-'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      saveCallImagesIfRequested(wrapped, tempDir);
      const files = fs.readdirSync(tempDir);
      expect(files.length).toBe(1);
      const first = files[0];
      expect(first?.endsWith('.png')).toBe(true);
      const outputPath = path.join(tempDir, first ?? '');
      expect(fs.readFileSync(outputPath, 'utf8')).toBe('hello');
    } finally {
      errorSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps json output on stdout unchanged when saving images', () => {
    const raw = {
      content: [
        { type: 'json', json: { id: 1 } },
        { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
      ],
    };
    const wrapped = createCallResult(raw);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcporter-images-'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      printCallOutput(wrapped, raw, 'json');
      saveCallImagesIfRequested(wrapped, tempDir);
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual({ id: 1 });
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

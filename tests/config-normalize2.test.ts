import { describe, expect, it, vi } from 'vitest';
import * as __testedFile from '../src/config-normalize';
import type { CommandSpec, RawEntry, RawLifecycle, ServerDefinition, ServerSource } from '../src/config-schema.js';
import { expandHome } from '../src/env.js';

const localSource: ServerSource = {
  kind: 'local',
  path: '/path',
  importKind: 'claude-code',
};

const twoSources = [localSource, localSource];

const rawEntry: RawEntry = {
  description: 'description',
  baseUrl: 'https://baseUrl',
  base_url: 'https://base_url',
  url: 'https://url',
  serverUrl: 'https://serverUrl',
  server_url: 'https://server_url',
  command: 'command',
  executable: 'executable',
  args: ['args'],
  headers: { header: 'value' },
  env: { ENV: 'value' },
  auth: 'OAUTH',
  tokenCacheDir: 'tokenCacheDir',
  token_cache_dir: 'token_cache_dir',
  clientName: 'clientName',
  client_name: 'client_name',
  oauthRedirectUrl: 'https://oauthRedirectUrl',
  oauth_redirect_url: 'https://oauth_redirect_url',
  oauthScope: 'oauthScope',
  oauth_scope: 'oauth_scope',
  oauthCommand: { args: ['oauthCommand'] },
  oauth_command: { args: ['oauth_command'] },
  bearerToken: 'bearerToken',
  bearer_token: 'bearer_token',
  bearerTokenEnv: 'bearerTokenEnv',
  bearer_token_env: 'bearer_token_env',
  lifecycle: 'keep-alive',
  logging: { daemon: { enabled: true } },
};

const rawEntryWrongUrl: RawEntry = {
  ...rawEntry,
  baseUrl: 'baseUrl',
  base_url: 'base_url',
  url: 'url',
  serverUrl: 'serverUrl',
  server_url: 'server_url',
  oauthRedirectUrl: 'oauthRedirectUrl',
  oauth_redirect_url: 'oauth_redirect_url',
};

const serverDefinition: ServerDefinition = {
  name: 'name',
  description: 'description',
  command: {
    kind: 'http',
    url: new URL('https://baseurl'),
    headers: {
      Authorization: '$env:bearerTokenEnv',
      accept: 'application/json, text/event-stream',
      header: 'value',
    },
  },
  env: { ENV: 'value' },
  auth: 'oauth',
  tokenCacheDir: 'tokenCacheDir',
  clientName: 'clientName',
  oauthRedirectUrl: 'https://oauthRedirectUrl',
  oauthScope: 'oauthScope',
  oauthCommand: { args: ['oauthCommand'] },
  source: { kind: 'local', path: '/path', importKind: 'claude-code' },
  sources: [],
  lifecycle: { mode: 'keep-alive' },
  logging: { daemon: { enabled: true } },
};

const httpHeadersBase: Record<string, string> = {
  header: 'value',
};

const httpHeadersJson: Record<string, string> = {
  ...httpHeadersBase,
  Authorization: '$env:bearerTokenEnv',
  accept: 'application/json',
};

const httpHeadersEvent: Record<string, string> = {
  ...httpHeadersBase,
  Authorization: '$env:bearerTokenEnv',
  accept: 'text/event-stream',
};

const expectedHttpHeadersBase = {
  accept: 'application/json, text/event-stream',
  header: 'value',
};

const expectedHttpHeadersFull = {
  Authorization: '$env:bearerTokenEnv',
  accept: 'application/json, text/event-stream',
  header: 'value',
};

describe('src/config-normalize.ts', () => {
  describe('normalizeServerEntry', () => {
    const { normalizeServerEntry } = __testedFile;
    // name: string
    // raw: RawEntry
    // baseDir: string
    // source: ServerSource
    // sources: readonly ServerSource[]

    it('should test normalizeServerEntry( mock-parameters.name 1, mock-parameters.raw 1, mock-parameters.baseDir 1, mock-parameters.source 1, mock-parameters.sources 1 )', () => {
      const name: Parameters<typeof normalizeServerEntry>[0] = 'name';
      const raw: Parameters<typeof normalizeServerEntry>[1] = rawEntry;
      const baseDir: Parameters<typeof normalizeServerEntry>[2] = 'baseDir';
      const source: Parameters<typeof normalizeServerEntry>[3] = localSource;
      const sources: Parameters<typeof normalizeServerEntry>[4] = [];
      const __expectedResult: ReturnType<typeof normalizeServerEntry> = serverDefinition;
      expect(normalizeServerEntry(name, raw, baseDir, source, sources)).toEqual(__expectedResult);
    });

    it('[bug] Invalid URL', () => {
      const name: Parameters<typeof normalizeServerEntry>[0] = 'name';
      const raw: Parameters<typeof normalizeServerEntry>[1] = rawEntryWrongUrl;
      const baseDir: Parameters<typeof normalizeServerEntry>[2] = 'baseDir';
      const source: Parameters<typeof normalizeServerEntry>[3] = localSource;
      const sources: Parameters<typeof normalizeServerEntry>[4] = [];
      expect(() => normalizeServerEntry(name, raw, baseDir, source, sources)).toThrow('Invalid URL');
    });

    it('should test normalizeServerEntry( mock-parameters.name 1, mock-parameters.raw 3, mock-parameters.baseDir 1, mock-parameters.source 1, mock-parameters.sources 1 )', () => {
      const name: Parameters<typeof normalizeServerEntry>[0] = 'name';
      const raw: Parameters<typeof normalizeServerEntry>[1] = {};
      const baseDir: Parameters<typeof normalizeServerEntry>[2] = 'baseDir';
      const source: Parameters<typeof normalizeServerEntry>[3] = localSource;
      const sources: Parameters<typeof normalizeServerEntry>[4] = [];
      expect(() => normalizeServerEntry(name, raw, baseDir, source, sources)).toThrow(
        "Server 'name' is missing a baseUrl/url or command definition in mcporter.json",
      );
    });

    it('should test normalizeServerEntry( mock-parameters.name 1, mock-parameters.raw 1, mock-parameters.baseDir 1, mock-parameters.source 1, mock-parameters.sources 2 )', () => {
      const name: Parameters<typeof normalizeServerEntry>[0] = 'name';
      const raw: Parameters<typeof normalizeServerEntry>[1] = rawEntry;
      const baseDir: Parameters<typeof normalizeServerEntry>[2] = 'baseDir';
      const source: Parameters<typeof normalizeServerEntry>[3] = localSource;
      const sources: Parameters<typeof normalizeServerEntry>[4] = twoSources;
      const __expectedResult: ReturnType<typeof normalizeServerEntry> = { ...serverDefinition, sources: twoSources };
      expect(normalizeServerEntry(name, raw, baseDir, source, sources)).toEqual(__expectedResult);
    });

    it('should test normalizeServerEntry( mock-parameters.name 1, mock-parameters.raw 3, mock-parameters.baseDir 1, mock-parameters.source 1, mock-parameters.sources 2 )', () => {
      const name: Parameters<typeof normalizeServerEntry>[0] = 'name';
      const raw: Parameters<typeof normalizeServerEntry>[1] = {};
      const baseDir: Parameters<typeof normalizeServerEntry>[2] = 'baseDir';
      const source: Parameters<typeof normalizeServerEntry>[3] = localSource;
      const sources: Parameters<typeof normalizeServerEntry>[4] = twoSources;
      expect(() => normalizeServerEntry(name, raw, baseDir, source, sources)).toThrow(
        "Server 'name' is missing a baseUrl/url or command definition in mcporter.json",
      );
    });
  });

  describe('normalizeAuth', () => {
    const { normalizeAuth } = __testedFile;
    // auth: string

    it('should test normalizeAuth( mock-parameters.auth 1 )', () => {
      const auth: Parameters<typeof normalizeAuth>[0] = '-oauth';
      const __expectedResult: ReturnType<typeof normalizeAuth> = undefined;
      expect(normalizeAuth(auth)).toEqual(__expectedResult);
    });

    it('should test normalizeAuth( mock-parameters.auth 2 )', () => {
      const auth: Parameters<typeof normalizeAuth>[0] = 'OAUTH';
      const __expectedResult: ReturnType<typeof normalizeAuth> = 'oauth';
      expect(normalizeAuth(auth)).toEqual(__expectedResult);
    });

    it('should test normalizeAuth( mock-parameters.auth 3 )', () => {
      const auth: Parameters<typeof normalizeAuth>[0] = 'misc';
      const __expectedResult: ReturnType<typeof normalizeAuth> = undefined;
      expect(normalizeAuth(auth)).toEqual(__expectedResult);
    });

    it('should test normalizeAuth( mock-parameters.auth 4 )', () => {
      const auth: Parameters<typeof normalizeAuth>[0] = 'oauth';
      const __expectedResult: ReturnType<typeof normalizeAuth> = 'oauth';
      expect(normalizeAuth(auth)).toEqual(__expectedResult);
    });

    it('should test normalizeAuth( mock-parameters.auth 5 )', () => {
      const auth: Parameters<typeof normalizeAuth>[0] = 'oauth-';
      const __expectedResult: ReturnType<typeof normalizeAuth> = undefined;
      expect(normalizeAuth(auth)).toEqual(__expectedResult);
    });

    it('should test normalizeAuth( mock-parameters.auth 6 )', () => {
      const auth: Parameters<typeof normalizeAuth>[0] = undefined;
      const __expectedResult: ReturnType<typeof normalizeAuth> = undefined;
      expect(normalizeAuth(auth)).toEqual(__expectedResult);
    });
  });

  describe('normalizePath', () => {
    const { normalizePath } = __testedFile;
    // input: string

    it('normalize path', () => {
      const input: Parameters<typeof normalizePath>[0] = '/path/abc';
      const __expectedResult: ReturnType<typeof normalizePath> = '/path/abc';
      expect(normalizePath(input)).toEqual(__expectedResult);
      expect(expandHome).toHaveBeenCalledWith('/path/abc');
    });

    it('should test normalizePath( mock-parameters.input 2 )', () => {
      const input: Parameters<typeof normalizePath>[0] = undefined;
      const __expectedResult: ReturnType<typeof normalizePath> = undefined;
      expect(normalizePath(input)).toEqual(__expectedResult);
    });
  });

  describe('getUrl', () => {
    const { getUrl } = __testedFile;
    // rawUrls: RawEntry

    it('should test getUrl( mock-parameters.rawUrls 1 )', () => {
      const rawUrls: Parameters<typeof getUrl>[0] = {
        baseUrl: 'raw.baseUrl',
        base_url: 'raw.base_url',
        serverUrl: 'raw.serverUrl',
        server_url: 'raw.server_url',
      } as RawEntry;
      const __expectedResult: ReturnType<typeof getUrl> = 'raw.baseUrl';
      expect(getUrl(rawUrls)).toEqual(__expectedResult);
    });

    it('should test getUrl( mock-parameters.rawUrls 2 )', () => {
      const rawUrls: Parameters<typeof getUrl>[0] = {
        baseUrl: 'raw.baseUrl',
        base_url: 'raw.base_url',
        serverUrl: 'raw.serverUrl',
      } as RawEntry;
      const __expectedResult: ReturnType<typeof getUrl> = 'raw.baseUrl';
      expect(getUrl(rawUrls)).toEqual(__expectedResult);
    });

    it('should test getUrl( mock-parameters.rawUrls 3 )', () => {
      const rawUrls: Parameters<typeof getUrl>[0] = {
        baseUrl: 'raw.baseUrl',
        base_url: 'raw.base_url',
        server_url: 'raw.server_url',
      } as RawEntry;
      const __expectedResult: ReturnType<typeof getUrl> = 'raw.baseUrl';
      expect(getUrl(rawUrls)).toEqual(__expectedResult);
    });

    it('should test getUrl( mock-parameters.rawUrls 4 )', () => {
      const rawUrls: Parameters<typeof getUrl>[0] = {
        baseUrl: 'raw.baseUrl',
        base_url: 'raw.base_url',
        url: 'raw.url',
        serverUrl: 'raw.serverUrl',
        server_url: 'raw.server_url',
      } as RawEntry;
      const __expectedResult: ReturnType<typeof getUrl> = 'raw.baseUrl';
      expect(getUrl(rawUrls)).toEqual(__expectedResult);
    });

    it('should test getUrl( mock-parameters.rawUrls 5 )', () => {
      const rawUrls: Parameters<typeof getUrl>[0] = {
        baseUrl: 'raw.baseUrl',
        base_url: 'raw.base_url',
        url: 'raw.url',
        serverUrl: 'raw.serverUrl',
      } as RawEntry;
      const __expectedResult: ReturnType<typeof getUrl> = 'raw.baseUrl';
      expect(getUrl(rawUrls)).toEqual(__expectedResult);
    });

    it('should test getUrl( mock-parameters.rawUrls 6 )', () => {
      const rawUrls: Parameters<typeof getUrl>[0] = {
        baseUrl: 'raw.baseUrl',
        base_url: 'raw.base_url',
        url: 'raw.url',
        server_url: 'raw.server_url',
      } as RawEntry;
      const __expectedResult: ReturnType<typeof getUrl> = 'raw.baseUrl';
      expect(getUrl(rawUrls)).toEqual(__expectedResult);
    });

    it('should test getUrl( mock-parameters.rawUrls 7 )', () => {
      const rawUrls: Parameters<typeof getUrl>[0] = {
        baseUrl: 'raw.baseUrl',
        base_url: 'raw.base_url',
        url: 'raw.url',
      } as RawEntry;
      const __expectedResult: ReturnType<typeof getUrl> = 'raw.baseUrl';
      expect(getUrl(rawUrls)).toEqual(__expectedResult);
    });

    it('should test getUrl( mock-parameters.rawUrls 8 )', () => {
      const rawUrls: Parameters<typeof getUrl>[0] = { baseUrl: 'raw.baseUrl', base_url: 'raw.base_url' } as RawEntry;
      const __expectedResult: ReturnType<typeof getUrl> = 'raw.baseUrl';
      expect(getUrl(rawUrls)).toEqual(__expectedResult);
    });

    it('should test getUrl( mock-parameters.rawUrls 9 )', () => {
      const rawUrls: Parameters<typeof getUrl>[0] = {
        baseUrl: 'raw.baseUrl',
        serverUrl: 'raw.serverUrl',
        server_url: 'raw.server_url',
      } as RawEntry;
      const __expectedResult: ReturnType<typeof getUrl> = 'raw.baseUrl';
      expect(getUrl(rawUrls)).toEqual(__expectedResult);
    });

    it('should test getUrl( mock-parameters.rawUrls 10 )', () => {
      const rawUrls: Parameters<typeof getUrl>[0] = { baseUrl: 'raw.baseUrl', serverUrl: 'raw.serverUrl' } as RawEntry;
      const __expectedResult: ReturnType<typeof getUrl> = 'raw.baseUrl';
      expect(getUrl(rawUrls)).toEqual(__expectedResult);
    });

    it('should test getUrl( mock-parameters.rawUrls 11 )', () => {
      const rawUrls: Parameters<typeof getUrl>[0] = {
        baseUrl: 'raw.baseUrl',
        server_url: 'raw.server_url',
      } as RawEntry;
      const __expectedResult: ReturnType<typeof getUrl> = 'raw.baseUrl';
      expect(getUrl(rawUrls)).toEqual(__expectedResult);
    });

    it('should test getUrl( mock-parameters.rawUrls 12 )', () => {
      const rawUrls: Parameters<typeof getUrl>[0] = {
        baseUrl: 'raw.baseUrl',
        url: 'raw.url',
        serverUrl: 'raw.serverUrl',
        server_url: 'raw.server_url',
      } as RawEntry;
      const __expectedResult: ReturnType<typeof getUrl> = 'raw.baseUrl';
      expect(getUrl(rawUrls)).toEqual(__expectedResult);
    });

    it('should test getUrl( mock-parameters.rawUrls 13 )', () => {
      const rawUrls: Parameters<typeof getUrl>[0] = {
        baseUrl: 'raw.baseUrl',
        url: 'raw.url',
        serverUrl: 'raw.serverUrl',
      } as RawEntry;
      const __expectedResult: ReturnType<typeof getUrl> = 'raw.baseUrl';
      expect(getUrl(rawUrls)).toEqual(__expectedResult);
    });

    it('should test getUrl( mock-parameters.rawUrls 14 )', () => {
      const rawUrls: Parameters<typeof getUrl>[0] = {
        baseUrl: 'raw.baseUrl',
        url: 'raw.url',
        server_url: 'raw.server_url',
      } as RawEntry;
      const __expectedResult: ReturnType<typeof getUrl> = 'raw.baseUrl';
      expect(getUrl(rawUrls)).toEqual(__expectedResult);
    });

    it('should test getUrl( mock-parameters.rawUrls 15 )', () => {
      const rawUrls: Parameters<typeof getUrl>[0] = { baseUrl: 'raw.baseUrl', url: 'raw.url' } as RawEntry;
      const __expectedResult: ReturnType<typeof getUrl> = 'raw.baseUrl';
      expect(getUrl(rawUrls)).toEqual(__expectedResult);
    });

    it('should test getUrl( mock-parameters.rawUrls 16 )', () => {
      const rawUrls: Parameters<typeof getUrl>[0] = { baseUrl: 'raw.baseUrl' } as RawEntry;
      const __expectedResult: ReturnType<typeof getUrl> = 'raw.baseUrl';
      expect(getUrl(rawUrls)).toEqual(__expectedResult);
    });

    it('should test getUrl( mock-parameters.rawUrls 17 )', () => {
      const rawUrls: Parameters<typeof getUrl>[0] = {
        base_url: 'raw.base_url',
        serverUrl: 'raw.serverUrl',
        server_url: 'raw.server_url',
      } as RawEntry;
      const __expectedResult: ReturnType<typeof getUrl> = 'raw.base_url';
      expect(getUrl(rawUrls)).toEqual(__expectedResult);
    });

    it('should test getUrl( mock-parameters.rawUrls 18 )', () => {
      const rawUrls: Parameters<typeof getUrl>[0] = {
        base_url: 'raw.base_url',
        serverUrl: 'raw.serverUrl',
      } as RawEntry;
      const __expectedResult: ReturnType<typeof getUrl> = 'raw.base_url';
      expect(getUrl(rawUrls)).toEqual(__expectedResult);
    });

    it('should test getUrl( mock-parameters.rawUrls 19 )', () => {
      const rawUrls: Parameters<typeof getUrl>[0] = {
        base_url: 'raw.base_url',
        server_url: 'raw.server_url',
      } as RawEntry;
      const __expectedResult: ReturnType<typeof getUrl> = 'raw.base_url';
      expect(getUrl(rawUrls)).toEqual(__expectedResult);
    });

    it('should test getUrl( mock-parameters.rawUrls 20 )', () => {
      const rawUrls: Parameters<typeof getUrl>[0] = {
        base_url: 'raw.base_url',
        url: 'raw.url',
        serverUrl: 'raw.serverUrl',
        server_url: 'raw.server_url',
      } as RawEntry;
      const __expectedResult: ReturnType<typeof getUrl> = 'raw.base_url';
      expect(getUrl(rawUrls)).toEqual(__expectedResult);
    });

    it('should test getUrl( mock-parameters.rawUrls 21 )', () => {
      const rawUrls: Parameters<typeof getUrl>[0] = {
        base_url: 'raw.base_url',
        url: 'raw.url',
        serverUrl: 'raw.serverUrl',
      } as RawEntry;
      const __expectedResult: ReturnType<typeof getUrl> = 'raw.base_url';
      expect(getUrl(rawUrls)).toEqual(__expectedResult);
    });

    it('should test getUrl( mock-parameters.rawUrls 22 )', () => {
      const rawUrls: Parameters<typeof getUrl>[0] = {
        base_url: 'raw.base_url',
        url: 'raw.url',
        server_url: 'raw.server_url',
      } as RawEntry;
      const __expectedResult: ReturnType<typeof getUrl> = 'raw.base_url';
      expect(getUrl(rawUrls)).toEqual(__expectedResult);
    });

    it('should test getUrl( mock-parameters.rawUrls 23 )', () => {
      const rawUrls: Parameters<typeof getUrl>[0] = { base_url: 'raw.base_url', url: 'raw.url' } as RawEntry;
      const __expectedResult: ReturnType<typeof getUrl> = 'raw.base_url';
      expect(getUrl(rawUrls)).toEqual(__expectedResult);
    });

    it('should test getUrl( mock-parameters.rawUrls 24 )', () => {
      const rawUrls: Parameters<typeof getUrl>[0] = { base_url: 'raw.base_url' } as RawEntry;
      const __expectedResult: ReturnType<typeof getUrl> = 'raw.base_url';
      expect(getUrl(rawUrls)).toEqual(__expectedResult);
    });

    it('should test getUrl( mock-parameters.rawUrls 25 )', () => {
      const rawUrls: Parameters<typeof getUrl>[0] = {
        serverUrl: 'raw.serverUrl',
        server_url: 'raw.server_url',
      } as RawEntry;
      const __expectedResult: ReturnType<typeof getUrl> = 'raw.serverUrl';
      expect(getUrl(rawUrls)).toEqual(__expectedResult);
    });

    it('should test getUrl( mock-parameters.rawUrls 26 )', () => {
      const rawUrls: Parameters<typeof getUrl>[0] = { serverUrl: 'raw.serverUrl' } as RawEntry;
      const __expectedResult: ReturnType<typeof getUrl> = 'raw.serverUrl';
      expect(getUrl(rawUrls)).toEqual(__expectedResult);
    });

    it('should test getUrl( mock-parameters.rawUrls 27 )', () => {
      const rawUrls: Parameters<typeof getUrl>[0] = { server_url: 'raw.server_url' } as RawEntry;
      const __expectedResult: ReturnType<typeof getUrl> = 'raw.server_url';
      expect(getUrl(rawUrls)).toEqual(__expectedResult);
    });

    it('should test getUrl( mock-parameters.rawUrls 28 )', () => {
      const rawUrls: Parameters<typeof getUrl>[0] = {
        url: 'raw.url',
        serverUrl: 'raw.serverUrl',
        server_url: 'raw.server_url',
      } as RawEntry;
      const __expectedResult: ReturnType<typeof getUrl> = 'raw.url';
      expect(getUrl(rawUrls)).toEqual(__expectedResult);
    });

    it('should test getUrl( mock-parameters.rawUrls 29 )', () => {
      const rawUrls: Parameters<typeof getUrl>[0] = { url: 'raw.url', serverUrl: 'raw.serverUrl' } as RawEntry;
      const __expectedResult: ReturnType<typeof getUrl> = 'raw.url';
      expect(getUrl(rawUrls)).toEqual(__expectedResult);
    });

    it('should test getUrl( mock-parameters.rawUrls 30 )', () => {
      const rawUrls: Parameters<typeof getUrl>[0] = { url: 'raw.url', server_url: 'raw.server_url' } as RawEntry;
      const __expectedResult: ReturnType<typeof getUrl> = 'raw.url';
      expect(getUrl(rawUrls)).toEqual(__expectedResult);
    });

    it('should test getUrl( mock-parameters.rawUrls 31 )', () => {
      const rawUrls: Parameters<typeof getUrl>[0] = { url: 'raw.url' } as RawEntry;
      const __expectedResult: ReturnType<typeof getUrl> = 'raw.url';
      expect(getUrl(rawUrls)).toEqual(__expectedResult);
    });

    it('should test getUrl( mock-parameters.rawUrls 32 )', () => {
      const rawUrls: Parameters<typeof getUrl>[0] = {} as RawEntry;
      const __expectedResult: ReturnType<typeof getUrl> = undefined;
      expect(getUrl(rawUrls)).toEqual(__expectedResult);
    });
  });

  describe('getCommand', () => {
    const { getCommand } = __testedFile;
    // command: RawEntry
    // executable: RawEntry
    // args: RawEntry

    it('should test getCommand( mock-parameters.command 1, mock-parameters.executable 1, mock-parameters.args 1 )', () => {
      const command: Parameters<typeof getCommand>[0] = '';
      const executable: Parameters<typeof getCommand>[1] = '';
      const args: Parameters<typeof getCommand>[2] = ['arg9'];
      const __expectedResult: ReturnType<typeof getCommand> = undefined;
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 2, mock-parameters.executable 1, mock-parameters.args 1 )', () => {
      const command: Parameters<typeof getCommand>[0] = 'cmd.sh';
      const executable: Parameters<typeof getCommand>[1] = '';
      const args: Parameters<typeof getCommand>[2] = ['arg9'];
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'cmd.sh', args: ['arg9'] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 3, mock-parameters.executable 1, mock-parameters.args 1 )', () => {
      const command: Parameters<typeof getCommand>[0] = ['cmd.sh', 'arg1'];
      const executable: Parameters<typeof getCommand>[1] = '';
      const args: Parameters<typeof getCommand>[2] = ['arg9'];
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'cmd.sh', args: ['arg1'] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 4, mock-parameters.executable 1, mock-parameters.args 1 )', () => {
      const command: Parameters<typeof getCommand>[0] = ['cmd.sh'];
      const executable: Parameters<typeof getCommand>[1] = '';
      const args: Parameters<typeof getCommand>[2] = ['arg9'];
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'cmd.sh', args: [] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 5, mock-parameters.executable 1, mock-parameters.args 1 )', () => {
      const command: Parameters<typeof getCommand>[0] = undefined;
      const executable: Parameters<typeof getCommand>[1] = '';
      const args: Parameters<typeof getCommand>[2] = ['arg9'];
      const __expectedResult: ReturnType<typeof getCommand> = undefined;
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 1, mock-parameters.executable 2, mock-parameters.args 1 )', () => {
      const command: Parameters<typeof getCommand>[0] = '';
      const executable: Parameters<typeof getCommand>[1] = 'exec.sh arg2';
      const args: Parameters<typeof getCommand>[2] = ['arg9'];
      const __expectedResult: ReturnType<typeof getCommand> = undefined;
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 2, mock-parameters.executable 2, mock-parameters.args 1 )', () => {
      const command: Parameters<typeof getCommand>[0] = 'cmd.sh';
      const executable: Parameters<typeof getCommand>[1] = 'exec.sh arg2';
      const args: Parameters<typeof getCommand>[2] = ['arg9'];
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'cmd.sh', args: ['arg9'] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 3, mock-parameters.executable 2, mock-parameters.args 1 )', () => {
      const command: Parameters<typeof getCommand>[0] = ['cmd.sh', 'arg1'];
      const executable: Parameters<typeof getCommand>[1] = 'exec.sh arg2';
      const args: Parameters<typeof getCommand>[2] = ['arg9'];
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'cmd.sh', args: ['arg1'] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 4, mock-parameters.executable 2, mock-parameters.args 1 )', () => {
      const command: Parameters<typeof getCommand>[0] = ['cmd.sh'];
      const executable: Parameters<typeof getCommand>[1] = 'exec.sh arg2';
      const args: Parameters<typeof getCommand>[2] = ['arg9'];
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'cmd.sh', args: [] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 5, mock-parameters.executable 2, mock-parameters.args 1 )', () => {
      const command: Parameters<typeof getCommand>[0] = undefined;
      const executable: Parameters<typeof getCommand>[1] = 'exec.sh arg2';
      const args: Parameters<typeof getCommand>[2] = ['arg9'];
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'exec.sh arg2', args: ['arg9'] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 1, mock-parameters.executable 3, mock-parameters.args 1 )', () => {
      const command: Parameters<typeof getCommand>[0] = '';
      const executable: Parameters<typeof getCommand>[1] = 'exec.sh';
      const args: Parameters<typeof getCommand>[2] = ['arg9'];
      const __expectedResult: ReturnType<typeof getCommand> = undefined;
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 2, mock-parameters.executable 3, mock-parameters.args 1 )', () => {
      const command: Parameters<typeof getCommand>[0] = 'cmd.sh';
      const executable: Parameters<typeof getCommand>[1] = 'exec.sh';
      const args: Parameters<typeof getCommand>[2] = ['arg9'];
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'cmd.sh', args: ['arg9'] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 3, mock-parameters.executable 3, mock-parameters.args 1 )', () => {
      const command: Parameters<typeof getCommand>[0] = ['cmd.sh', 'arg1'];
      const executable: Parameters<typeof getCommand>[1] = 'exec.sh';
      const args: Parameters<typeof getCommand>[2] = ['arg9'];
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'cmd.sh', args: ['arg1'] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 4, mock-parameters.executable 3, mock-parameters.args 1 )', () => {
      const command: Parameters<typeof getCommand>[0] = ['cmd.sh'];
      const executable: Parameters<typeof getCommand>[1] = 'exec.sh';
      const args: Parameters<typeof getCommand>[2] = ['arg9'];
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'cmd.sh', args: [] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 5, mock-parameters.executable 3, mock-parameters.args 1 )', () => {
      const command: Parameters<typeof getCommand>[0] = undefined;
      const executable: Parameters<typeof getCommand>[1] = 'exec.sh';
      const args: Parameters<typeof getCommand>[2] = ['arg9'];
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'exec.sh', args: ['arg9'] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 1, mock-parameters.executable 4, mock-parameters.args 1 )', () => {
      const command: Parameters<typeof getCommand>[0] = '';
      const executable: Parameters<typeof getCommand>[1] = undefined;
      const args: Parameters<typeof getCommand>[2] = ['arg9'];
      const __expectedResult: ReturnType<typeof getCommand> = undefined;
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 2, mock-parameters.executable 4, mock-parameters.args 1 )', () => {
      const command: Parameters<typeof getCommand>[0] = 'cmd.sh';
      const executable: Parameters<typeof getCommand>[1] = undefined;
      const args: Parameters<typeof getCommand>[2] = ['arg9'];
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'cmd.sh', args: ['arg9'] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 3, mock-parameters.executable 4, mock-parameters.args 1 )', () => {
      const command: Parameters<typeof getCommand>[0] = ['cmd.sh', 'arg1'];
      const executable: Parameters<typeof getCommand>[1] = undefined;
      const args: Parameters<typeof getCommand>[2] = ['arg9'];
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'cmd.sh', args: ['arg1'] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 4, mock-parameters.executable 4, mock-parameters.args 1 )', () => {
      const command: Parameters<typeof getCommand>[0] = ['cmd.sh'];
      const executable: Parameters<typeof getCommand>[1] = undefined;
      const args: Parameters<typeof getCommand>[2] = ['arg9'];
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'cmd.sh', args: [] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 5, mock-parameters.executable 4, mock-parameters.args 1 )', () => {
      const command: Parameters<typeof getCommand>[0] = undefined;
      const executable: Parameters<typeof getCommand>[1] = undefined;
      const args: Parameters<typeof getCommand>[2] = ['arg9'];
      const __expectedResult: ReturnType<typeof getCommand> = undefined;
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 1, mock-parameters.executable 1, mock-parameters.args 2 )', () => {
      const command: Parameters<typeof getCommand>[0] = '';
      const executable: Parameters<typeof getCommand>[1] = '';
      const args: Parameters<typeof getCommand>[2] = [];
      const __expectedResult: ReturnType<typeof getCommand> = undefined;
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 2, mock-parameters.executable 1, mock-parameters.args 2 )', () => {
      const command: Parameters<typeof getCommand>[0] = 'cmd.sh';
      const executable: Parameters<typeof getCommand>[1] = '';
      const args: Parameters<typeof getCommand>[2] = [];
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'cmd.sh', args: [] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 3, mock-parameters.executable 1, mock-parameters.args 2 )', () => {
      const command: Parameters<typeof getCommand>[0] = ['cmd.sh', 'arg1'];
      const executable: Parameters<typeof getCommand>[1] = '';
      const args: Parameters<typeof getCommand>[2] = [];
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'cmd.sh', args: ['arg1'] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 4, mock-parameters.executable 1, mock-parameters.args 2 )', () => {
      const command: Parameters<typeof getCommand>[0] = ['cmd.sh'];
      const executable: Parameters<typeof getCommand>[1] = '';
      const args: Parameters<typeof getCommand>[2] = [];
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'cmd.sh', args: [] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 5, mock-parameters.executable 1, mock-parameters.args 2 )', () => {
      const command: Parameters<typeof getCommand>[0] = undefined;
      const executable: Parameters<typeof getCommand>[1] = '';
      const args: Parameters<typeof getCommand>[2] = [];
      const __expectedResult: ReturnType<typeof getCommand> = undefined;
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 1, mock-parameters.executable 2, mock-parameters.args 2 )', () => {
      const command: Parameters<typeof getCommand>[0] = '';
      const executable: Parameters<typeof getCommand>[1] = 'exec.sh arg2';
      const args: Parameters<typeof getCommand>[2] = [];
      const __expectedResult: ReturnType<typeof getCommand> = undefined;
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 2, mock-parameters.executable 2, mock-parameters.args 2 )', () => {
      const command: Parameters<typeof getCommand>[0] = 'cmd.sh';
      const executable: Parameters<typeof getCommand>[1] = 'exec.sh arg2';
      const args: Parameters<typeof getCommand>[2] = [];
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'cmd.sh', args: [] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 3, mock-parameters.executable 2, mock-parameters.args 2 )', () => {
      const command: Parameters<typeof getCommand>[0] = ['cmd.sh', 'arg1'];
      const executable: Parameters<typeof getCommand>[1] = 'exec.sh arg2';
      const args: Parameters<typeof getCommand>[2] = [];
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'cmd.sh', args: ['arg1'] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 4, mock-parameters.executable 2, mock-parameters.args 2 )', () => {
      const command: Parameters<typeof getCommand>[0] = ['cmd.sh'];
      const executable: Parameters<typeof getCommand>[1] = 'exec.sh arg2';
      const args: Parameters<typeof getCommand>[2] = [];
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'cmd.sh', args: [] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 5, mock-parameters.executable 2, mock-parameters.args 2 )', () => {
      const command: Parameters<typeof getCommand>[0] = undefined;
      const executable: Parameters<typeof getCommand>[1] = 'exec.sh arg2';
      const args: Parameters<typeof getCommand>[2] = [];
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'exec.sh', args: ['arg2'] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 1, mock-parameters.executable 3, mock-parameters.args 2 )', () => {
      const command: Parameters<typeof getCommand>[0] = '';
      const executable: Parameters<typeof getCommand>[1] = 'exec.sh';
      const args: Parameters<typeof getCommand>[2] = [];
      const __expectedResult: ReturnType<typeof getCommand> = undefined;
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 2, mock-parameters.executable 3, mock-parameters.args 2 )', () => {
      const command: Parameters<typeof getCommand>[0] = 'cmd.sh';
      const executable: Parameters<typeof getCommand>[1] = 'exec.sh';
      const args: Parameters<typeof getCommand>[2] = [];
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'cmd.sh', args: [] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 3, mock-parameters.executable 3, mock-parameters.args 2 )', () => {
      const command: Parameters<typeof getCommand>[0] = ['cmd.sh', 'arg1'];
      const executable: Parameters<typeof getCommand>[1] = 'exec.sh';
      const args: Parameters<typeof getCommand>[2] = [];
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'cmd.sh', args: ['arg1'] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 4, mock-parameters.executable 3, mock-parameters.args 2 )', () => {
      const command: Parameters<typeof getCommand>[0] = ['cmd.sh'];
      const executable: Parameters<typeof getCommand>[1] = 'exec.sh';
      const args: Parameters<typeof getCommand>[2] = [];
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'cmd.sh', args: [] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 5, mock-parameters.executable 3, mock-parameters.args 2 )', () => {
      const command: Parameters<typeof getCommand>[0] = undefined;
      const executable: Parameters<typeof getCommand>[1] = 'exec.sh';
      const args: Parameters<typeof getCommand>[2] = [];
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'exec.sh', args: [] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 1, mock-parameters.executable 4, mock-parameters.args 2 )', () => {
      const command: Parameters<typeof getCommand>[0] = '';
      const executable: Parameters<typeof getCommand>[1] = undefined;
      const args: Parameters<typeof getCommand>[2] = [];
      const __expectedResult: ReturnType<typeof getCommand> = undefined;
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 2, mock-parameters.executable 4, mock-parameters.args 2 )', () => {
      const command: Parameters<typeof getCommand>[0] = 'cmd.sh';
      const executable: Parameters<typeof getCommand>[1] = undefined;
      const args: Parameters<typeof getCommand>[2] = [];
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'cmd.sh', args: [] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 3, mock-parameters.executable 4, mock-parameters.args 2 )', () => {
      const command: Parameters<typeof getCommand>[0] = ['cmd.sh', 'arg1'];
      const executable: Parameters<typeof getCommand>[1] = undefined;
      const args: Parameters<typeof getCommand>[2] = [];
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'cmd.sh', args: ['arg1'] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 4, mock-parameters.executable 4, mock-parameters.args 2 )', () => {
      const command: Parameters<typeof getCommand>[0] = ['cmd.sh'];
      const executable: Parameters<typeof getCommand>[1] = undefined;
      const args: Parameters<typeof getCommand>[2] = [];
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'cmd.sh', args: [] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 5, mock-parameters.executable 4, mock-parameters.args 2 )', () => {
      const command: Parameters<typeof getCommand>[0] = undefined;
      const executable: Parameters<typeof getCommand>[1] = undefined;
      const args: Parameters<typeof getCommand>[2] = [];
      const __expectedResult: ReturnType<typeof getCommand> = undefined;
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 1, mock-parameters.executable 1, mock-parameters.args 3 )', () => {
      const command: Parameters<typeof getCommand>[0] = '';
      const executable: Parameters<typeof getCommand>[1] = '';
      const args: Parameters<typeof getCommand>[2] = undefined;
      const __expectedResult: ReturnType<typeof getCommand> = undefined;
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 2, mock-parameters.executable 1, mock-parameters.args 3 )', () => {
      const command: Parameters<typeof getCommand>[0] = 'cmd.sh';
      const executable: Parameters<typeof getCommand>[1] = '';
      const args: Parameters<typeof getCommand>[2] = undefined;
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'cmd.sh', args: [] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 3, mock-parameters.executable 1, mock-parameters.args 3 )', () => {
      const command: Parameters<typeof getCommand>[0] = ['cmd.sh', 'arg1'];
      const executable: Parameters<typeof getCommand>[1] = '';
      const args: Parameters<typeof getCommand>[2] = undefined;
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'cmd.sh', args: ['arg1'] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 4, mock-parameters.executable 1, mock-parameters.args 3 )', () => {
      const command: Parameters<typeof getCommand>[0] = ['cmd.sh'];
      const executable: Parameters<typeof getCommand>[1] = '';
      const args: Parameters<typeof getCommand>[2] = undefined;
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'cmd.sh', args: [] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 5, mock-parameters.executable 1, mock-parameters.args 3 )', () => {
      const command: Parameters<typeof getCommand>[0] = undefined;
      const executable: Parameters<typeof getCommand>[1] = '';
      const args: Parameters<typeof getCommand>[2] = undefined;
      const __expectedResult: ReturnType<typeof getCommand> = undefined;
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 1, mock-parameters.executable 2, mock-parameters.args 3 )', () => {
      const command: Parameters<typeof getCommand>[0] = '';
      const executable: Parameters<typeof getCommand>[1] = 'exec.sh arg2';
      const args: Parameters<typeof getCommand>[2] = undefined;
      const __expectedResult: ReturnType<typeof getCommand> = undefined;
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 2, mock-parameters.executable 2, mock-parameters.args 3 )', () => {
      const command: Parameters<typeof getCommand>[0] = 'cmd.sh';
      const executable: Parameters<typeof getCommand>[1] = 'exec.sh arg2';
      const args: Parameters<typeof getCommand>[2] = undefined;
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'cmd.sh', args: [] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 3, mock-parameters.executable 2, mock-parameters.args 3 )', () => {
      const command: Parameters<typeof getCommand>[0] = ['cmd.sh', 'arg1'];
      const executable: Parameters<typeof getCommand>[1] = 'exec.sh arg2';
      const args: Parameters<typeof getCommand>[2] = undefined;
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'cmd.sh', args: ['arg1'] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 4, mock-parameters.executable 2, mock-parameters.args 3 )', () => {
      const command: Parameters<typeof getCommand>[0] = ['cmd.sh'];
      const executable: Parameters<typeof getCommand>[1] = 'exec.sh arg2';
      const args: Parameters<typeof getCommand>[2] = undefined;
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'cmd.sh', args: [] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 5, mock-parameters.executable 2, mock-parameters.args 3 )', () => {
      const command: Parameters<typeof getCommand>[0] = undefined;
      const executable: Parameters<typeof getCommand>[1] = 'exec.sh arg2';
      const args: Parameters<typeof getCommand>[2] = undefined;
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'exec.sh', args: ['arg2'] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 1, mock-parameters.executable 3, mock-parameters.args 3 )', () => {
      const command: Parameters<typeof getCommand>[0] = '';
      const executable: Parameters<typeof getCommand>[1] = 'exec.sh';
      const args: Parameters<typeof getCommand>[2] = undefined;
      const __expectedResult: ReturnType<typeof getCommand> = undefined;
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 2, mock-parameters.executable 3, mock-parameters.args 3 )', () => {
      const command: Parameters<typeof getCommand>[0] = 'cmd.sh';
      const executable: Parameters<typeof getCommand>[1] = 'exec.sh';
      const args: Parameters<typeof getCommand>[2] = undefined;
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'cmd.sh', args: [] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 3, mock-parameters.executable 3, mock-parameters.args 3 )', () => {
      const command: Parameters<typeof getCommand>[0] = ['cmd.sh', 'arg1'];
      const executable: Parameters<typeof getCommand>[1] = 'exec.sh';
      const args: Parameters<typeof getCommand>[2] = undefined;
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'cmd.sh', args: ['arg1'] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 4, mock-parameters.executable 3, mock-parameters.args 3 )', () => {
      const command: Parameters<typeof getCommand>[0] = ['cmd.sh'];
      const executable: Parameters<typeof getCommand>[1] = 'exec.sh';
      const args: Parameters<typeof getCommand>[2] = undefined;
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'cmd.sh', args: [] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 5, mock-parameters.executable 3, mock-parameters.args 3 )', () => {
      const command: Parameters<typeof getCommand>[0] = undefined;
      const executable: Parameters<typeof getCommand>[1] = 'exec.sh';
      const args: Parameters<typeof getCommand>[2] = undefined;
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'exec.sh', args: [] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 1, mock-parameters.executable 4, mock-parameters.args 3 )', () => {
      const command: Parameters<typeof getCommand>[0] = '';
      const executable: Parameters<typeof getCommand>[1] = undefined;
      const args: Parameters<typeof getCommand>[2] = undefined;
      const __expectedResult: ReturnType<typeof getCommand> = undefined;
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 2, mock-parameters.executable 4, mock-parameters.args 3 )', () => {
      const command: Parameters<typeof getCommand>[0] = 'cmd.sh';
      const executable: Parameters<typeof getCommand>[1] = undefined;
      const args: Parameters<typeof getCommand>[2] = undefined;
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'cmd.sh', args: [] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 3, mock-parameters.executable 4, mock-parameters.args 3 )', () => {
      const command: Parameters<typeof getCommand>[0] = ['cmd.sh', 'arg1'];
      const executable: Parameters<typeof getCommand>[1] = undefined;
      const args: Parameters<typeof getCommand>[2] = undefined;
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'cmd.sh', args: ['arg1'] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 4, mock-parameters.executable 4, mock-parameters.args 3 )', () => {
      const command: Parameters<typeof getCommand>[0] = ['cmd.sh'];
      const executable: Parameters<typeof getCommand>[1] = undefined;
      const args: Parameters<typeof getCommand>[2] = undefined;
      const __expectedResult: ReturnType<typeof getCommand> = { command: 'cmd.sh', args: [] };
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });

    it('should test getCommand( mock-parameters.command 5, mock-parameters.executable 4, mock-parameters.args 3 )', () => {
      const command: Parameters<typeof getCommand>[0] = undefined;
      const executable: Parameters<typeof getCommand>[1] = undefined;
      const args: Parameters<typeof getCommand>[2] = undefined;
      const __expectedResult: ReturnType<typeof getCommand> = undefined;
      expect(getCommand(command, executable, args)).toEqual(__expectedResult);
    });
  });

  describe('buildHeaders', () => {
    const { buildHeaders } = __testedFile;
    // bearerToken: undefined | string
    // bearer_token: undefined | string
    // bearerTokenEnv: undefined | string
    // bearer_token_env: undefined | string
    // customHeaders: undefined | Record<string, string>

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearerToken' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearerToken' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearer_token' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearerToken' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearerToken' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearerToken' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearer_token' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearerToken' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearerToken' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearerToken' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearer_token' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearerToken' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearer_token_env' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearer_token_env' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearer_token_env' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearer_token_env' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearer_token_env' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearer_token_env' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearer_token_env' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearer_token_env' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearer_token_env' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearerToken' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearerToken' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearer_token' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearerToken' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearerToken' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearerToken' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearer_token' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearerToken' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 1 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = undefined;
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = { accept: 'application/json' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: 'Bearer bearerToken',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = { accept: 'application/json' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = { accept: 'application/json' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: 'Bearer bearerToken',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: 'Bearer bearer_token',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = { accept: 'application/json' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: 'Bearer bearerToken',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = { accept: 'application/json' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: '$env:bearerTokenEnv',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: '$env:bearerTokenEnv',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: '$env:bearerTokenEnv',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: '$env:bearerTokenEnv',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: '$env:bearerTokenEnv',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: '$env:bearerTokenEnv',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: '$env:bearerTokenEnv',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: '$env:bearerTokenEnv',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: '$env:bearerTokenEnv',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = { accept: 'application/json' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: 'Bearer bearerToken',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = { accept: 'application/json' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = { accept: 'application/json' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: 'Bearer bearerToken',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: 'Bearer bearer_token',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = { accept: 'application/json' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: 'Bearer bearerToken',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = { accept: 'application/json' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = { accept: 'application/json' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: 'Bearer bearerToken',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = { accept: 'application/json' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = { accept: 'application/json' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: 'Bearer bearerToken',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: 'Bearer bearer_token',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = { accept: 'application/json' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: 'Bearer bearerToken',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = { accept: 'application/json' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: '$env:bearerTokenEnv',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: '$env:bearerTokenEnv',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: '$env:bearerTokenEnv',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: '$env:bearerTokenEnv',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: '$env:bearerTokenEnv',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: '$env:bearerTokenEnv',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: '$env:bearerTokenEnv',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: '$env:bearerTokenEnv',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: '$env:bearerTokenEnv',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: '$env:bearer_token_env',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: '$env:bearer_token_env',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: '$env:bearer_token_env',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: '$env:bearer_token_env',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: '$env:bearer_token_env',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: '$env:bearer_token_env',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: '$env:bearer_token_env',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: '$env:bearer_token_env',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: '$env:bearer_token_env',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = { accept: 'application/json' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: 'Bearer bearerToken',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = { accept: 'application/json' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = { accept: 'application/json' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: 'Bearer bearerToken',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: 'Bearer bearer_token',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = { accept: 'application/json' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: 'Bearer bearerToken',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = { accept: 'application/json' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: '$env:bearerTokenEnv',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: '$env:bearerTokenEnv',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: '$env:bearerTokenEnv',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: '$env:bearerTokenEnv',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: '$env:bearerTokenEnv',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: '$env:bearerTokenEnv',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: '$env:bearerTokenEnv',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: '$env:bearerTokenEnv',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: '$env:bearerTokenEnv',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = { accept: 'application/json' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: 'Bearer bearerToken',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = { accept: 'application/json' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = { accept: 'application/json' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: 'Bearer bearerToken',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: 'Bearer bearer_token',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = { accept: 'application/json' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = {
        accept: 'application/json',
        Authorization: 'Bearer bearerToken',
      };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 2 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = { accept: 'application/json' };
      const __expectedResult: ReturnType<typeof buildHeaders> = { accept: 'application/json' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearerToken' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearerToken' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearer_token' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearerToken' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearerToken' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearerToken' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearer_token' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearerToken' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 1, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = '';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearerToken' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearerToken' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearer_token' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearerToken' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearer_token_env' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearer_token_env' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearer_token_env' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearer_token_env' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearer_token_env' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearer_token_env' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearer_token_env' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearer_token_env' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 2, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = 'bearer_token_env';
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearer_token_env' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearerToken' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearerToken' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearer_token' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearerToken' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 1, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = '';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 2, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = 'bearerTokenEnv';
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: '$env:bearerTokenEnv' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearerToken' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 1, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = '';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearerToken' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 2, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = 'bearer_token';
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearer_token' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 1, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = '';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 2, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = 'bearerToken';
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = { Authorization: 'Bearer bearerToken' };
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });

    it('should test buildHeaders( mock-parameters.bearerToken 3, mock-parameters.bearer_token 3, mock-parameters.bearerTokenEnv 3, mock-parameters.bearer_token_env 3, mock-parameters.customHeaders 3 )', () => {
      const bearerToken: Parameters<typeof buildHeaders>[0] = undefined;
      const bearer_token: Parameters<typeof buildHeaders>[1] = undefined;
      const bearerTokenEnv: Parameters<typeof buildHeaders>[2] = undefined;
      const bearer_token_env: Parameters<typeof buildHeaders>[3] = undefined;
      const customHeaders: Parameters<typeof buildHeaders>[4] = {};
      const __expectedResult: ReturnType<typeof buildHeaders> = undefined;
      expect(buildHeaders(bearerToken, bearer_token, bearerTokenEnv, bearer_token_env, customHeaders)).toEqual(
        __expectedResult,
      );
    });
  });

  describe('ensureHttpAcceptHeader', () => {
    const { ensureHttpAcceptHeader } = __testedFile;
    // headers: undefined | Record<string, string>

    it('should test ensureHttpAcceptHeader( mock-parameters.headers 1 )', () => {
      const headers: Parameters<typeof ensureHttpAcceptHeader>[0] = httpHeadersBase;
      const __expectedResult: ReturnType<typeof ensureHttpAcceptHeader> = expectedHttpHeadersBase;
      expect(ensureHttpAcceptHeader(headers)).toEqual(__expectedResult);
    });

    it('should test ensureHttpAcceptHeader( mock-parameters.headers 2 )', () => {
      const headers: Parameters<typeof ensureHttpAcceptHeader>[0] = httpHeadersEvent;
      const __expectedResult: ReturnType<typeof ensureHttpAcceptHeader> = expectedHttpHeadersFull;
      expect(ensureHttpAcceptHeader(headers)).toEqual(__expectedResult);
    });

    it('should test ensureHttpAcceptHeader( mock-parameters.headers 3 )', () => {
      const headers: Parameters<typeof ensureHttpAcceptHeader>[0] = httpHeadersJson;
      const __expectedResult: ReturnType<typeof ensureHttpAcceptHeader> = expectedHttpHeadersFull;
      expect(ensureHttpAcceptHeader(headers)).toEqual(__expectedResult);
    });

    it('should test ensureHttpAcceptHeader( mock-parameters.headers 4 )', () => {
      const headers: Parameters<typeof ensureHttpAcceptHeader>[0] = undefined;
      const __expectedResult: ReturnType<typeof ensureHttpAcceptHeader> = {
        accept: 'application/json, text/event-stream',
      };
      expect(ensureHttpAcceptHeader(headers)).toEqual(__expectedResult);
    });

    it('should test ensureHttpAcceptHeader( mock-parameters.headers 5 )', () => {
      const headers: Parameters<typeof ensureHttpAcceptHeader>[0] = {};
      const __expectedResult: ReturnType<typeof ensureHttpAcceptHeader> = {
        accept: 'application/json, text/event-stream',
      };
      expect(ensureHttpAcceptHeader(headers)).toEqual(__expectedResult);
    });
  });

  describe('hasRequiredAcceptTokens', () => {
    const { hasRequiredAcceptTokens } = __testedFile;
    // acceptTokens: string

    it('should test hasRequiredAcceptTokens( mock-parameters.acceptTokens 1 )', () => {
      const acceptTokens: Parameters<typeof hasRequiredAcceptTokens>[0] = '';
      const __expectedResult: ReturnType<typeof hasRequiredAcceptTokens> = false;
      expect(hasRequiredAcceptTokens(acceptTokens)).toEqual(__expectedResult);
    });

    it('should test hasRequiredAcceptTokens( mock-parameters.acceptTokens 2 )', () => {
      const acceptTokens: Parameters<typeof hasRequiredAcceptTokens>[0] = 'APPLICATION/JSON, TEXT/EVENT-STREAM';
      const __expectedResult: ReturnType<typeof hasRequiredAcceptTokens> = true;
      expect(hasRequiredAcceptTokens(acceptTokens)).toEqual(__expectedResult);
    });

    it('should test hasRequiredAcceptTokens( mock-parameters.acceptTokens 3 )', () => {
      const acceptTokens: Parameters<typeof hasRequiredAcceptTokens>[0] = 'TEXT/EVENT-STREAM, APPLICATION/JSON';
      const __expectedResult: ReturnType<typeof hasRequiredAcceptTokens> = true;
      expect(hasRequiredAcceptTokens(acceptTokens)).toEqual(__expectedResult);
    });

    it('should test hasRequiredAcceptTokens( mock-parameters.acceptTokens 4 )', () => {
      const acceptTokens: Parameters<typeof hasRequiredAcceptTokens>[0] = 'application/json';
      const __expectedResult: ReturnType<typeof hasRequiredAcceptTokens> = false;
      expect(hasRequiredAcceptTokens(acceptTokens)).toEqual(__expectedResult);
    });

    it('should test hasRequiredAcceptTokens( mock-parameters.acceptTokens 5 )', () => {
      const acceptTokens: Parameters<typeof hasRequiredAcceptTokens>[0] = 'application/json, text/event-stream';
      const __expectedResult: ReturnType<typeof hasRequiredAcceptTokens> = true;
      expect(hasRequiredAcceptTokens(acceptTokens)).toEqual(__expectedResult);
    });

    it.skip('[bug] Invalid Content-Type', () => {
      const acceptTokens: Parameters<typeof hasRequiredAcceptTokens>[0] = 'application/jsontext/event-stream';
      const __expectedResult: ReturnType<typeof hasRequiredAcceptTokens> = false;
      expect(hasRequiredAcceptTokens(acceptTokens)).toEqual(__expectedResult);
    });

    it('should test hasRequiredAcceptTokens( mock-parameters.acceptTokens 7 )', () => {
      const acceptTokens: Parameters<typeof hasRequiredAcceptTokens>[0] = 'text/event-stream';
      const __expectedResult: ReturnType<typeof hasRequiredAcceptTokens> = false;
      expect(hasRequiredAcceptTokens(acceptTokens)).toEqual(__expectedResult);
    });

    it('should test hasRequiredAcceptTokens( mock-parameters.acceptTokens 8 )', () => {
      const acceptTokens: Parameters<typeof hasRequiredAcceptTokens>[0] = 'text/event-stream, application/json';
      const __expectedResult: ReturnType<typeof hasRequiredAcceptTokens> = true;
      expect(hasRequiredAcceptTokens(acceptTokens)).toEqual(__expectedResult);
    });

    it('should test hasRequiredAcceptTokens( mock-parameters.acceptTokens 9 )', () => {
      const acceptTokens: Parameters<typeof hasRequiredAcceptTokens>[0] = 'text/html, image/png';
      const __expectedResult: ReturnType<typeof hasRequiredAcceptTokens> = false;
      expect(hasRequiredAcceptTokens(acceptTokens)).toEqual(__expectedResult);
    });
  });

  describe('parseCommandString', () => {
    const { parseCommandString } = __testedFile;
    // commandString: string

    it('Nested quotes (D in S)', () => {
      const commandString: Parameters<typeof parseCommandString>[0] = '\'Say "Hello"\'';
      const __expectedResult: ReturnType<typeof parseCommandString> = ['Say "Hello"'];
      expect(parseCommandString(commandString)).toEqual(__expectedResult);
    });

    it('Double quotes', () => {
      const commandString: Parameters<typeof parseCommandString>[0] = "'quoted string'";
      const __expectedResult: ReturnType<typeof parseCommandString> = ['quoted string'];
      expect(parseCommandString(commandString)).toEqual(__expectedResult);
    });

    it('Only spaces', () => {
      const commandString: Parameters<typeof parseCommandString>[0] = ' ';
      const __expectedResult: ReturnType<typeof parseCommandString> = [];
      expect(parseCommandString(commandString)).toEqual(__expectedResult);
    });

    it('Leading/Trailing spaces', () => {
      const commandString: Parameters<typeof parseCommandString>[0] = ' echo hello ';
      const __expectedResult: ReturnType<typeof parseCommandString> = ['echo', 'hello'];
      expect(parseCommandString(commandString)).toEqual(__expectedResult);
    });

    it('Nested quotes (S in D)', () => {
      const commandString: Parameters<typeof parseCommandString>[0] = '"It\'s a test"';
      const __expectedResult: ReturnType<typeof parseCommandString> = ["It's a test"];
      expect(parseCommandString(commandString)).toEqual(__expectedResult);
    });

    it('Single quotes', () => {
      const commandString: Parameters<typeof parseCommandString>[0] = '"my program" --run';
      const __expectedResult: ReturnType<typeof parseCommandString> = ['my program', '--run'];
      expect(parseCommandString(commandString)).toEqual(__expectedResult);
    });

    it('Empty string', () => {
      const commandString: Parameters<typeof parseCommandString>[0] = '';
      const __expectedResult: ReturnType<typeof parseCommandString> = [];
      expect(parseCommandString(commandString)).toEqual(__expectedResult);
    });

    it('Escaped backslash', () => {
      const commandString: Parameters<typeof parseCommandString>[0] = 'C:\Windows';
      const __expectedResult: ReturnType<typeof parseCommandString> = ['C:\Windows'];
      expect(parseCommandString(commandString)).toEqual(__expectedResult);
    });

    it('Mixed tokens', () => {
      const commandString: Parameters<typeof parseCommandString>[0] = 'cmd \'arg 1\' "arg 2"';
      const __expectedResult: ReturnType<typeof parseCommandString> = ['cmd', 'arg 1', 'arg 2'];
      expect(parseCommandString(commandString)).toEqual(__expectedResult);
    });

    it('Unclosed quote', () => {
      const commandString: Parameters<typeof parseCommandString>[0] = "echo 'hello";
      const __expectedResult: ReturnType<typeof parseCommandString> = ['echo', 'hello'];
      expect(parseCommandString(commandString)).toEqual(__expectedResult);
    });

    it('Escaped space', () => {
      const commandString: Parameters<typeof parseCommandString>[0] = 'file\ name.txt';
      const __expectedResult: ReturnType<typeof parseCommandString> = ['file', 'name.txt'];
      expect(parseCommandString(commandString)).toEqual(__expectedResult);
    });

    it('Command with argument', () => {
      const commandString: Parameters<typeof parseCommandString>[0] = 'git status';
      const __expectedResult: ReturnType<typeof parseCommandString> = ['git', 'status'];
      expect(parseCommandString(commandString)).toEqual(__expectedResult);
    });

    it('Command with options', () => {
      const commandString: Parameters<typeof parseCommandString>[0] = 'ls -la';
      const __expectedResult: ReturnType<typeof parseCommandString> = ['ls', '-la'];
      expect(parseCommandString(commandString)).toEqual(__expectedResult);
    });

    it('Basic command', () => {
      const commandString: Parameters<typeof parseCommandString>[0] = 'ls';
      const __expectedResult: ReturnType<typeof parseCommandString> = ['ls'];
      expect(parseCommandString(commandString)).toEqual(__expectedResult);
    });
  });

  describe('normalizeLogging', () => {
    const { normalizeLogging } = __testedFile;
    // logginValue: undefined | { daemon?: { enabled?: boolean; }; }

    it('no daemon', () => {
      const logginValue: Parameters<typeof normalizeLogging>[0] = undefined;
      const __expectedResult: ReturnType<typeof normalizeLogging> = undefined;
      expect(normalizeLogging(logginValue)).toEqual(__expectedResult);
    });

    it('daemon undefined', () => {
      const logginValue: Parameters<typeof normalizeLogging>[0] = { daemon: undefined };
      const __expectedResult: ReturnType<typeof normalizeLogging> = undefined;
      expect(normalizeLogging(logginValue)).toEqual(__expectedResult);
    });

    it('daemon enabled', () => {
      const logginValue: Parameters<typeof normalizeLogging>[0] = { daemon: { enabled: true } };
      const __expectedResult: ReturnType<typeof normalizeLogging> = { daemon: { enabled: true } };
      expect(normalizeLogging(logginValue)).toEqual(__expectedResult);
    });

    it.skip('[bug] undefined daemon enabled', () => {
      const logginValue: Parameters<typeof normalizeLogging>[0] = { daemon: {} };
      const __expectedResult: ReturnType<typeof normalizeLogging> = { daemon: { enabled: false } };
      expect(normalizeLogging(logginValue)).toEqual(__expectedResult);
    });
  });
});

vi.mock('../src/env.js', async () => {
  const m = vi.importActual('../src/env.js');
  return {
    ...m,
    expandHome: vi.fn((input: string) => input),
  };
});

vi.mock('../src/lifecycle.js', async () => {
  const m = vi.importActual('../src/lifecycle.js');
  return {
    ...m,
    resolveLifecycle: (name: string, rawLifecycle: RawLifecycle | undefined, command: CommandSpec) => ({
      mode: rawLifecycle,
    }),
  };
});

// 3TG (https://3tg.dev) created 380 tests in 2728 ms (7.179 ms per generated test) @ 2026-03-16T20:28:06.206Z

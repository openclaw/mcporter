# Exported functions from "src/config-normalize.ts"

<!--
```json configuration
{
  "testing-framework": "vitest",
  "no-mock-imports": true
}
```

```typescript before
import type { RawLifecycle } from './config-schema.js';
```
-->

## normalizeServerEntry(name: string, raw: RawEntry, baseDir: string, source: ServerSource, sources: ServerSource[])

These are the functional requirements for function `normalizeServerEntry`.

### Without raw entry

| test name | name   | raw      | baseDir   | source      | sources    | normalizeServerEntry                                                                  |
| --------- | ------ | -------- | --------- | ----------- | ---------- | ------------------------------------------------------------------------------------- |
|           | 'name' | {}       | 'baseDir' | localSource | []         | throw "Server 'name' is missing a baseUrl/url or command definition in mcporter.json" |
|           | 'name' | {}       | 'baseDir' | localSource | twoSources | throw "Server 'name' is missing a baseUrl/url or command definition in mcporter.json" |
|           | 'name' | rawEntry | 'baseDir' | localSource | []         | serverDefinition                                                                      |
|           | 'name' | rawEntry | 'baseDir' | localSource | twoSources | {...serverDefinition, sources: twoSources}                                            |

### Found Bugs

1. If `getUrl` - when called from `normalizeServerEntry` - returns a URL from a field in `RawEntry` which is not a valid URL string, the app will throw an `Invalid URL` at src/config-normalize.ts:31.

| test name         | name   | raw              | baseDir   | source      | sources | normalizeServerEntry |
| ----------------- | ------ | ---------------- | --------- | ----------- | ------- | -------------------- |
| [bug] Invalid URL | 'name' | rawEntryWrongUrl | 'baseDir' | localSource | []      | throw 'Invalid URL'  |
| !IGNORE!          | 'name' | rawEntryWrongUrl | 'baseDir' |             |         |                      |

```typescript before
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
```

## normalizeAuth(auth: string)

These are the functional requirements for function `normalizeAuth`.

| test name | auth      | normalizeAuth |
| --------- | --------- | ------------- |
|           | undefined | undefined     |
|           | 'oauth'   | 'oauth'       |
|           | 'OAUTH'   | 'oauth'       |
|           | '-oauth'  | undefined     |
|           | 'oauth-'  | undefined     |
|           | 'misc'    | undefined     |

## normalizePath(input: string)

These are the functional requirements for function `normalizePath`.

| test name      | input       | normalizePath |
| -------------- | ----------- | ------------- |
|                | undefined   | undefined     |
| normalize path | '/path/abc' | '/path/abc'   |

```typescript scenario(normalize path)
expect(expandHome).toHaveBeenCalledWith('/path/abc');
```

## getUrl(rawUrls: RawEntry)

These are the functional requirements for function `getUrl`.

| test name | rawUrls                                                                                                                                  | getUrl           |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
|           | {} as RawEntry                                                                                                                           | undefined        |
|           | {baseUrl: 'raw.baseUrl', base_url: 'raw.base_url', server_url: 'raw.server_url'} as RawEntry                                             | 'raw.baseUrl'    |
|           | {baseUrl: 'raw.baseUrl', base_url: 'raw.base_url', serverUrl: 'raw.serverUrl', server_url: 'raw.server_url'} as RawEntry                 | 'raw.baseUrl'    |
|           | {baseUrl: 'raw.baseUrl', base_url: 'raw.base_url', serverUrl: 'raw.serverUrl'} as RawEntry                                               | 'raw.baseUrl'    |
|           | {baseUrl: 'raw.baseUrl', base_url: 'raw.base_url', url: 'raw.url', server_url: 'raw.server_url'} as RawEntry                             | 'raw.baseUrl'    |
|           | {baseUrl: 'raw.baseUrl', base_url: 'raw.base_url', url: 'raw.url', serverUrl: 'raw.serverUrl', server_url: 'raw.server_url'} as RawEntry | 'raw.baseUrl'    |
|           | {baseUrl: 'raw.baseUrl', base_url: 'raw.base_url', url: 'raw.url', serverUrl: 'raw.serverUrl'} as RawEntry                               | 'raw.baseUrl'    |
|           | {baseUrl: 'raw.baseUrl', base_url: 'raw.base_url', url: 'raw.url'} as RawEntry                                                           | 'raw.baseUrl'    |
|           | {baseUrl: 'raw.baseUrl', base_url: 'raw.base_url'} as RawEntry                                                                           | 'raw.baseUrl'    |
|           | {baseUrl: 'raw.baseUrl', server_url: 'raw.server_url'} as RawEntry                                                                       | 'raw.baseUrl'    |
|           | {baseUrl: 'raw.baseUrl', serverUrl: 'raw.serverUrl', server_url: 'raw.server_url'} as RawEntry                                           | 'raw.baseUrl'    |
|           | {baseUrl: 'raw.baseUrl', serverUrl: 'raw.serverUrl'} as RawEntry                                                                         | 'raw.baseUrl'    |
|           | {baseUrl: 'raw.baseUrl', url: 'raw.url', server_url: 'raw.server_url'} as RawEntry                                                       | 'raw.baseUrl'    |
|           | {baseUrl: 'raw.baseUrl', url: 'raw.url', serverUrl: 'raw.serverUrl', server_url: 'raw.server_url'} as RawEntry                           | 'raw.baseUrl'    |
|           | {baseUrl: 'raw.baseUrl', url: 'raw.url', serverUrl: 'raw.serverUrl'} as RawEntry                                                         | 'raw.baseUrl'    |
|           | {baseUrl: 'raw.baseUrl', url: 'raw.url'} as RawEntry                                                                                     | 'raw.baseUrl'    |
|           | {baseUrl: 'raw.baseUrl'} as RawEntry                                                                                                     | 'raw.baseUrl'    |
|           | {base_url: 'raw.base_url', server_url: 'raw.server_url'} as RawEntry                                                                     | 'raw.base_url'   |
|           | {base_url: 'raw.base_url', serverUrl: 'raw.serverUrl', server_url: 'raw.server_url'} as RawEntry                                         | 'raw.base_url'   |
|           | {base_url: 'raw.base_url', serverUrl: 'raw.serverUrl'} as RawEntry                                                                       | 'raw.base_url'   |
|           | {base_url: 'raw.base_url', url: 'raw.url', server_url: 'raw.server_url'} as RawEntry                                                     | 'raw.base_url'   |
|           | {base_url: 'raw.base_url', url: 'raw.url', serverUrl: 'raw.serverUrl', server_url: 'raw.server_url'} as RawEntry                         | 'raw.base_url'   |
|           | {base_url: 'raw.base_url', url: 'raw.url', serverUrl: 'raw.serverUrl'} as RawEntry                                                       | 'raw.base_url'   |
|           | {base_url: 'raw.base_url', url: 'raw.url'} as RawEntry                                                                                   | 'raw.base_url'   |
|           | {base_url: 'raw.base_url'} as RawEntry                                                                                                   | 'raw.base_url'   |
|           | {url: 'raw.url', server_url: 'raw.server_url'} as RawEntry                                                                               | 'raw.url'        |
|           | {url: 'raw.url', serverUrl: 'raw.serverUrl', server_url: 'raw.server_url'} as RawEntry                                                   | 'raw.url'        |
|           | {url: 'raw.url', serverUrl: 'raw.serverUrl'} as RawEntry                                                                                 | 'raw.url'        |
|           | {url: 'raw.url'} as RawEntry                                                                                                             | 'raw.url'        |
|           | {serverUrl: 'raw.serverUrl', server_url: 'raw.server_url'} as RawEntry                                                                   | 'raw.serverUrl'  |
|           | {serverUrl: 'raw.serverUrl'} as RawEntry                                                                                                 | 'raw.serverUrl'  |
|           | {server_url: 'raw.server_url'} as RawEntry                                                                                               | 'raw.server_url' |

## getCommand(command?: string|string[], executable?: string, args?: string[])

These are the functional requirements for function `getCommand`.

| test name | command            | executable     | args      | getCommand                                  |
| --------- | ------------------ | -------------- | --------- | ------------------------------------------- |
|           | undefined          | ''             | ['arg9']  | undefined                                   |
|           | undefined          | ''             | []        | undefined                                   |
|           | undefined          | ''             | undefined | undefined                                   |
|           | undefined          | 'exec.sh arg2' | ['arg9']  | { command: 'exec.sh arg2', args: ['arg9'] } |
|           | undefined          | 'exec.sh arg2' | []        | { command: 'exec.sh', args: ['arg2'] }      |
|           | undefined          | 'exec.sh arg2' | undefined | { command: 'exec.sh', args: ['arg2'] }      |
|           | undefined          | 'exec.sh'      | ['arg9']  | { command: 'exec.sh', args: ['arg9'] }      |
|           | undefined          | 'exec.sh'      | []        | { command: 'exec.sh', args: [] }            |
|           | undefined          | 'exec.sh'      | undefined | { command: 'exec.sh', args: [] }            |
|           | undefined          | undefined      | ['arg9']  | undefined                                   |
|           | undefined          | undefined      | []        | undefined                                   |
|           | undefined          | undefined      | undefined | undefined                                   |
|           | ''                 | ''             | ['arg9']  | undefined                                   |
|           | ''                 | ''             | []        | undefined                                   |
|           | ''                 | ''             | undefined | undefined                                   |
|           | ''                 | 'exec.sh arg2' | ['arg9']  | undefined                                   |
|           | ''                 | 'exec.sh arg2' | []        | undefined                                   |
|           | ''                 | 'exec.sh arg2' | undefined | undefined                                   |
|           | ''                 | 'exec.sh'      | ['arg9']  | undefined                                   |
|           | ''                 | 'exec.sh'      | []        | undefined                                   |
|           | ''                 | 'exec.sh'      | undefined | undefined                                   |
|           | ''                 | undefined      | ['arg9']  | undefined                                   |
|           | ''                 | undefined      | []        | undefined                                   |
|           | ''                 | undefined      | undefined | undefined                                   |
|           | 'cmd.sh'           | ''             | ['arg9']  | { command: 'cmd.sh', args: ['arg9'] }       |
|           | 'cmd.sh'           | ''             | []        | { command: 'cmd.sh', args: [] }             |
|           | 'cmd.sh'           | ''             | undefined | { command: 'cmd.sh', args: [] }             |
|           | 'cmd.sh'           | 'exec.sh arg2' | ['arg9']  | { command: 'cmd.sh', args: ['arg9'] }       |
|           | 'cmd.sh'           | 'exec.sh arg2' | []        | { command: 'cmd.sh', args: [] }             |
|           | 'cmd.sh'           | 'exec.sh arg2' | undefined | { command: 'cmd.sh', args: [] }             |
|           | 'cmd.sh'           | 'exec.sh'      | ['arg9']  | { command: 'cmd.sh', args: ['arg9'] }       |
|           | 'cmd.sh'           | 'exec.sh'      | []        | { command: 'cmd.sh', args: [] }             |
|           | 'cmd.sh'           | 'exec.sh'      | undefined | { command: 'cmd.sh', args: [] }             |
|           | 'cmd.sh'           | undefined      | ['arg9']  | { command: 'cmd.sh', args: ['arg9'] }       |
|           | 'cmd.sh'           | undefined      | []        | { command: 'cmd.sh', args: [] }             |
|           | 'cmd.sh'           | undefined      | undefined | { command: 'cmd.sh', args: [] }             |
|           | ['cmd.sh']         | ''             | ['arg9']  | { command: 'cmd.sh', args: [] }             |
|           | ['cmd.sh']         | ''             | []        | { command: 'cmd.sh', args: [] }             |
|           | ['cmd.sh']         | ''             | undefined | { command: 'cmd.sh', args: [] }             |
|           | ['cmd.sh']         | 'exec.sh arg2' | ['arg9']  | { command: 'cmd.sh', args: [] }             |
|           | ['cmd.sh']         | 'exec.sh arg2' | []        | { command: 'cmd.sh', args: [] }             |
|           | ['cmd.sh']         | 'exec.sh arg2' | undefined | { command: 'cmd.sh', args: [] }             |
|           | ['cmd.sh']         | 'exec.sh'      | ['arg9']  | { command: 'cmd.sh', args: [] }             |
|           | ['cmd.sh']         | 'exec.sh'      | []        | { command: 'cmd.sh', args: [] }             |
|           | ['cmd.sh']         | 'exec.sh'      | undefined | { command: 'cmd.sh', args: [] }             |
|           | ['cmd.sh']         | undefined      | ['arg9']  | { command: 'cmd.sh', args: [] }             |
|           | ['cmd.sh']         | undefined      | []        | { command: 'cmd.sh', args: [] }             |
|           | ['cmd.sh']         | undefined      | undefined | { command: 'cmd.sh', args: [] }             |
|           | ['cmd.sh', 'arg1'] | ''             | ['arg9']  | { command: 'cmd.sh', args: ['arg1'] }       |
|           | ['cmd.sh', 'arg1'] | ''             | []        | { command: 'cmd.sh', args: ['arg1'] }       |
|           | ['cmd.sh', 'arg1'] | ''             | undefined | { command: 'cmd.sh', args: ['arg1'] }       |
|           | ['cmd.sh', 'arg1'] | 'exec.sh arg2' | ['arg9']  | { command: 'cmd.sh', args: ['arg1'] }       |
|           | ['cmd.sh', 'arg1'] | 'exec.sh arg2' | []        | { command: 'cmd.sh', args: ['arg1'] }       |
|           | ['cmd.sh', 'arg1'] | 'exec.sh arg2' | undefined | { command: 'cmd.sh', args: ['arg1'] }       |
|           | ['cmd.sh', 'arg1'] | 'exec.sh'      | ['arg9']  | { command: 'cmd.sh', args: ['arg1'] }       |
|           | ['cmd.sh', 'arg1'] | 'exec.sh'      | []        | { command: 'cmd.sh', args: ['arg1'] }       |
|           | ['cmd.sh', 'arg1'] | 'exec.sh'      | undefined | { command: 'cmd.sh', args: ['arg1'] }       |
|           | ['cmd.sh', 'arg1'] | undefined      | ['arg9']  | { command: 'cmd.sh', args: ['arg1'] }       |
|           | ['cmd.sh', 'arg1'] | undefined      | []        | { command: 'cmd.sh', args: ['arg1'] }       |
|           | ['cmd.sh', 'arg1'] | undefined      | undefined | { command: 'cmd.sh', args: ['arg1'] }       |

## buildHeaders(bearerToken?: string, bearer_token?: string, bearerTokenEnv?: string, bearer_token_env?: string, customHeaders?: Record<string, string>)

These are the functional requirements for function `buildHeaders`.

| test name | bearerToken   | bearer_token   | bearerTokenEnv   | bearer_token_env   | customHeaders                 | buildHeaders                                                          |
| --------- | ------------- | -------------- | ---------------- | ------------------ | ----------------------------- | --------------------------------------------------------------------- |
|           | ''            | ''             | ''               | ''                 | {"accept":"application/json"} | {"accept":"application/json"}                                         |
|           | ''            | ''             | ''               | ''                 | {}                            | undefined                                                             |
|           | ''            | ''             | ''               | ''                 | undefined                     | undefined                                                             |
|           | ''            | ''             | ''               | 'bearer_token_env' | {"accept":"application/json"} | {"accept":"application/json"}                                         |
|           | ''            | ''             | ''               | 'bearer_token_env' | {}                            | undefined                                                             |
|           | ''            | ''             | ''               | 'bearer_token_env' | undefined                     | undefined                                                             |
|           | ''            | ''             | ''               | undefined          | {"accept":"application/json"} | {"accept":"application/json"}                                         |
|           | ''            | ''             | ''               | undefined          | {}                            | undefined                                                             |
|           | ''            | ''             | ''               | undefined          | undefined                     | undefined                                                             |
|           | ''            | ''             | 'bearerTokenEnv' | ''                 | {"accept":"application/json"} | {"accept":"application/json","Authorization":"$env:bearerTokenEnv"}   |
|           | ''            | ''             | 'bearerTokenEnv' | ''                 | {}                            | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | ''            | ''             | 'bearerTokenEnv' | ''                 | undefined                     | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | ''            | ''             | 'bearerTokenEnv' | 'bearer_token_env' | {"accept":"application/json"} | {"accept":"application/json","Authorization":"$env:bearerTokenEnv"}   |
|           | ''            | ''             | 'bearerTokenEnv' | 'bearer_token_env' | {}                            | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | ''            | ''             | 'bearerTokenEnv' | 'bearer_token_env' | undefined                     | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | ''            | ''             | 'bearerTokenEnv' | undefined          | {"accept":"application/json"} | {"accept":"application/json","Authorization":"$env:bearerTokenEnv"}   |
|           | ''            | ''             | 'bearerTokenEnv' | undefined          | {}                            | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | ''            | ''             | 'bearerTokenEnv' | undefined          | undefined                     | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | ''            | ''             | undefined        | ''                 | {"accept":"application/json"} | {"accept":"application/json"}                                         |
|           | ''            | ''             | undefined        | ''                 | {}                            | undefined                                                             |
|           | ''            | ''             | undefined        | ''                 | undefined                     | undefined                                                             |
|           | ''            | ''             | undefined        | 'bearer_token_env' | {"accept":"application/json"} | {"accept":"application/json","Authorization":"$env:bearer_token_env"} |
|           | ''            | ''             | undefined        | 'bearer_token_env' | {}                            | {"Authorization":"$env:bearer_token_env"}                             |
|           | ''            | ''             | undefined        | 'bearer_token_env' | undefined                     | {"Authorization":"$env:bearer_token_env"}                             |
|           | ''            | ''             | undefined        | undefined          | {"accept":"application/json"} | {"accept":"application/json"}                                         |
|           | ''            | ''             | undefined        | undefined          | {}                            | undefined                                                             |
|           | ''            | ''             | undefined        | undefined          | undefined                     | undefined                                                             |
|           | ''            | 'bearer_token' | ''               | ''                 | {"accept":"application/json"} | {"accept":"application/json"}                                         |
|           | ''            | 'bearer_token' | ''               | ''                 | {}                            | undefined                                                             |
|           | ''            | 'bearer_token' | ''               | ''                 | undefined                     | undefined                                                             |
|           | ''            | 'bearer_token' | ''               | 'bearer_token_env' | {"accept":"application/json"} | {"accept":"application/json"}                                         |
|           | ''            | 'bearer_token' | ''               | 'bearer_token_env' | {}                            | undefined                                                             |
|           | ''            | 'bearer_token' | ''               | 'bearer_token_env' | undefined                     | undefined                                                             |
|           | ''            | 'bearer_token' | ''               | undefined          | {"accept":"application/json"} | {"accept":"application/json"}                                         |
|           | ''            | 'bearer_token' | ''               | undefined          | {}                            | undefined                                                             |
|           | ''            | 'bearer_token' | ''               | undefined          | undefined                     | undefined                                                             |
|           | ''            | 'bearer_token' | 'bearerTokenEnv' | ''                 | {"accept":"application/json"} | {"accept":"application/json","Authorization":"$env:bearerTokenEnv"}   |
|           | ''            | 'bearer_token' | 'bearerTokenEnv' | ''                 | {}                            | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | ''            | 'bearer_token' | 'bearerTokenEnv' | ''                 | undefined                     | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | ''            | 'bearer_token' | 'bearerTokenEnv' | 'bearer_token_env' | {"accept":"application/json"} | {"accept":"application/json","Authorization":"$env:bearerTokenEnv"}   |
|           | ''            | 'bearer_token' | 'bearerTokenEnv' | 'bearer_token_env' | {}                            | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | ''            | 'bearer_token' | 'bearerTokenEnv' | 'bearer_token_env' | undefined                     | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | ''            | 'bearer_token' | 'bearerTokenEnv' | undefined          | {"accept":"application/json"} | {"accept":"application/json","Authorization":"$env:bearerTokenEnv"}   |
|           | ''            | 'bearer_token' | 'bearerTokenEnv' | undefined          | {}                            | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | ''            | 'bearer_token' | 'bearerTokenEnv' | undefined          | undefined                     | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | ''            | 'bearer_token' | undefined        | ''                 | {"accept":"application/json"} | {"accept":"application/json"}                                         |
|           | ''            | 'bearer_token' | undefined        | ''                 | {}                            | undefined                                                             |
|           | ''            | 'bearer_token' | undefined        | ''                 | undefined                     | undefined                                                             |
|           | ''            | 'bearer_token' | undefined        | 'bearer_token_env' | {"accept":"application/json"} | {"accept":"application/json","Authorization":"$env:bearer_token_env"} |
|           | ''            | 'bearer_token' | undefined        | 'bearer_token_env' | {}                            | {"Authorization":"$env:bearer_token_env"}                             |
|           | ''            | 'bearer_token' | undefined        | 'bearer_token_env' | undefined                     | {"Authorization":"$env:bearer_token_env"}                             |
|           | ''            | 'bearer_token' | undefined        | undefined          | {"accept":"application/json"} | {"accept":"application/json"}                                         |
|           | ''            | 'bearer_token' | undefined        | undefined          | {}                            | undefined                                                             |
|           | ''            | 'bearer_token' | undefined        | undefined          | undefined                     | undefined                                                             |
|           | ''            | undefined      | ''               | ''                 | {"accept":"application/json"} | {"accept":"application/json"}                                         |
|           | ''            | undefined      | ''               | ''                 | {}                            | undefined                                                             |
|           | ''            | undefined      | ''               | ''                 | undefined                     | undefined                                                             |
|           | ''            | undefined      | ''               | 'bearer_token_env' | {"accept":"application/json"} | {"accept":"application/json"}                                         |
|           | ''            | undefined      | ''               | 'bearer_token_env' | {}                            | undefined                                                             |
|           | ''            | undefined      | ''               | 'bearer_token_env' | undefined                     | undefined                                                             |
|           | ''            | undefined      | ''               | undefined          | {"accept":"application/json"} | {"accept":"application/json"}                                         |
|           | ''            | undefined      | ''               | undefined          | {}                            | undefined                                                             |
|           | ''            | undefined      | ''               | undefined          | undefined                     | undefined                                                             |
|           | ''            | undefined      | 'bearerTokenEnv' | ''                 | {"accept":"application/json"} | {"accept":"application/json","Authorization":"$env:bearerTokenEnv"}   |
|           | ''            | undefined      | 'bearerTokenEnv' | ''                 | {}                            | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | ''            | undefined      | 'bearerTokenEnv' | ''                 | undefined                     | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | ''            | undefined      | 'bearerTokenEnv' | 'bearer_token_env' | {"accept":"application/json"} | {"accept":"application/json","Authorization":"$env:bearerTokenEnv"}   |
|           | ''            | undefined      | 'bearerTokenEnv' | 'bearer_token_env' | {}                            | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | ''            | undefined      | 'bearerTokenEnv' | 'bearer_token_env' | undefined                     | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | ''            | undefined      | 'bearerTokenEnv' | undefined          | {"accept":"application/json"} | {"accept":"application/json","Authorization":"$env:bearerTokenEnv"}   |
|           | ''            | undefined      | 'bearerTokenEnv' | undefined          | {}                            | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | ''            | undefined      | 'bearerTokenEnv' | undefined          | undefined                     | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | ''            | undefined      | undefined        | ''                 | {"accept":"application/json"} | {"accept":"application/json"}                                         |
|           | ''            | undefined      | undefined        | ''                 | {}                            | undefined                                                             |
|           | ''            | undefined      | undefined        | ''                 | undefined                     | undefined                                                             |
|           | ''            | undefined      | undefined        | 'bearer_token_env' | {"accept":"application/json"} | {"accept":"application/json","Authorization":"$env:bearer_token_env"} |
|           | ''            | undefined      | undefined        | 'bearer_token_env' | {}                            | {"Authorization":"$env:bearer_token_env"}                             |
|           | ''            | undefined      | undefined        | 'bearer_token_env' | undefined                     | {"Authorization":"$env:bearer_token_env"}                             |
|           | ''            | undefined      | undefined        | undefined          | {"accept":"application/json"} | {"accept":"application/json"}                                         |
|           | ''            | undefined      | undefined        | undefined          | {}                            | undefined                                                             |
|           | ''            | undefined      | undefined        | undefined          | undefined                     | undefined                                                             |
|           | 'bearerToken' | ''             | ''               | ''                 | {"accept":"application/json"} | {"accept":"application/json","Authorization":"Bearer bearerToken"}    |
|           | 'bearerToken' | ''             | ''               | ''                 | {}                            | {"Authorization":"Bearer bearerToken"}                                |
|           | 'bearerToken' | ''             | ''               | ''                 | undefined                     | {"Authorization":"Bearer bearerToken"}                                |
|           | 'bearerToken' | ''             | ''               | 'bearer_token_env' | {"accept":"application/json"} | {"accept":"application/json","Authorization":"Bearer bearerToken"}    |
|           | 'bearerToken' | ''             | ''               | 'bearer_token_env' | {}                            | {"Authorization":"Bearer bearerToken"}                                |
|           | 'bearerToken' | ''             | ''               | 'bearer_token_env' | undefined                     | {"Authorization":"Bearer bearerToken"}                                |
|           | 'bearerToken' | ''             | ''               | undefined          | {"accept":"application/json"} | {"accept":"application/json","Authorization":"Bearer bearerToken"}    |
|           | 'bearerToken' | ''             | ''               | undefined          | {}                            | {"Authorization":"Bearer bearerToken"}                                |
|           | 'bearerToken' | ''             | ''               | undefined          | undefined                     | {"Authorization":"Bearer bearerToken"}                                |
|           | 'bearerToken' | ''             | 'bearerTokenEnv' | ''                 | {"accept":"application/json"} | {"accept":"application/json","Authorization":"$env:bearerTokenEnv"}   |
|           | 'bearerToken' | ''             | 'bearerTokenEnv' | ''                 | {}                            | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | 'bearerToken' | ''             | 'bearerTokenEnv' | ''                 | undefined                     | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | 'bearerToken' | ''             | 'bearerTokenEnv' | 'bearer_token_env' | {"accept":"application/json"} | {"accept":"application/json","Authorization":"$env:bearerTokenEnv"}   |
|           | 'bearerToken' | ''             | 'bearerTokenEnv' | 'bearer_token_env' | {}                            | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | 'bearerToken' | ''             | 'bearerTokenEnv' | 'bearer_token_env' | undefined                     | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | 'bearerToken' | ''             | 'bearerTokenEnv' | undefined          | {"accept":"application/json"} | {"accept":"application/json","Authorization":"$env:bearerTokenEnv"}   |
|           | 'bearerToken' | ''             | 'bearerTokenEnv' | undefined          | {}                            | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | 'bearerToken' | ''             | 'bearerTokenEnv' | undefined          | undefined                     | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | 'bearerToken' | ''             | undefined        | ''                 | {"accept":"application/json"} | {"accept":"application/json","Authorization":"Bearer bearerToken"}    |
|           | 'bearerToken' | ''             | undefined        | ''                 | {}                            | {"Authorization":"Bearer bearerToken"}                                |
|           | 'bearerToken' | ''             | undefined        | ''                 | undefined                     | {"Authorization":"Bearer bearerToken"}                                |
|           | 'bearerToken' | ''             | undefined        | 'bearer_token_env' | {"accept":"application/json"} | {"accept":"application/json","Authorization":"$env:bearer_token_env"} |
|           | 'bearerToken' | ''             | undefined        | 'bearer_token_env' | {}                            | {"Authorization":"$env:bearer_token_env"}                             |
|           | 'bearerToken' | ''             | undefined        | 'bearer_token_env' | undefined                     | {"Authorization":"$env:bearer_token_env"}                             |
|           | 'bearerToken' | ''             | undefined        | undefined          | {"accept":"application/json"} | {"accept":"application/json","Authorization":"Bearer bearerToken"}    |
|           | 'bearerToken' | ''             | undefined        | undefined          | {}                            | {"Authorization":"Bearer bearerToken"}                                |
|           | 'bearerToken' | ''             | undefined        | undefined          | undefined                     | {"Authorization":"Bearer bearerToken"}                                |
|           | 'bearerToken' | 'bearer_token' | ''               | ''                 | {"accept":"application/json"} | {"accept":"application/json","Authorization":"Bearer bearerToken"}    |
|           | 'bearerToken' | 'bearer_token' | ''               | ''                 | {}                            | {"Authorization":"Bearer bearerToken"}                                |
|           | 'bearerToken' | 'bearer_token' | ''               | ''                 | undefined                     | {"Authorization":"Bearer bearerToken"}                                |
|           | 'bearerToken' | 'bearer_token' | ''               | 'bearer_token_env' | {"accept":"application/json"} | {"accept":"application/json","Authorization":"Bearer bearerToken"}    |
|           | 'bearerToken' | 'bearer_token' | ''               | 'bearer_token_env' | {}                            | {"Authorization":"Bearer bearerToken"}                                |
|           | 'bearerToken' | 'bearer_token' | ''               | 'bearer_token_env' | undefined                     | {"Authorization":"Bearer bearerToken"}                                |
|           | 'bearerToken' | 'bearer_token' | ''               | undefined          | {"accept":"application/json"} | {"accept":"application/json","Authorization":"Bearer bearerToken"}    |
|           | 'bearerToken' | 'bearer_token' | ''               | undefined          | {}                            | {"Authorization":"Bearer bearerToken"}                                |
|           | 'bearerToken' | 'bearer_token' | ''               | undefined          | undefined                     | {"Authorization":"Bearer bearerToken"}                                |
|           | 'bearerToken' | 'bearer_token' | 'bearerTokenEnv' | ''                 | {"accept":"application/json"} | {"accept":"application/json","Authorization":"$env:bearerTokenEnv"}   |
|           | 'bearerToken' | 'bearer_token' | 'bearerTokenEnv' | ''                 | {}                            | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | 'bearerToken' | 'bearer_token' | 'bearerTokenEnv' | ''                 | undefined                     | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | 'bearerToken' | 'bearer_token' | 'bearerTokenEnv' | 'bearer_token_env' | {"accept":"application/json"} | {"accept":"application/json","Authorization":"$env:bearerTokenEnv"}   |
|           | 'bearerToken' | 'bearer_token' | 'bearerTokenEnv' | 'bearer_token_env' | {}                            | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | 'bearerToken' | 'bearer_token' | 'bearerTokenEnv' | 'bearer_token_env' | undefined                     | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | 'bearerToken' | 'bearer_token' | 'bearerTokenEnv' | undefined          | {"accept":"application/json"} | {"accept":"application/json","Authorization":"$env:bearerTokenEnv"}   |
|           | 'bearerToken' | 'bearer_token' | 'bearerTokenEnv' | undefined          | {}                            | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | 'bearerToken' | 'bearer_token' | 'bearerTokenEnv' | undefined          | undefined                     | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | 'bearerToken' | 'bearer_token' | undefined        | ''                 | {"accept":"application/json"} | {"accept":"application/json","Authorization":"Bearer bearerToken"}    |
|           | 'bearerToken' | 'bearer_token' | undefined        | ''                 | {}                            | {"Authorization":"Bearer bearerToken"}                                |
|           | 'bearerToken' | 'bearer_token' | undefined        | ''                 | undefined                     | {"Authorization":"Bearer bearerToken"}                                |
|           | 'bearerToken' | 'bearer_token' | undefined        | 'bearer_token_env' | {"accept":"application/json"} | {"accept":"application/json","Authorization":"$env:bearer_token_env"} |
|           | 'bearerToken' | 'bearer_token' | undefined        | 'bearer_token_env' | {}                            | {"Authorization":"$env:bearer_token_env"}                             |
|           | 'bearerToken' | 'bearer_token' | undefined        | 'bearer_token_env' | undefined                     | {"Authorization":"$env:bearer_token_env"}                             |
|           | 'bearerToken' | 'bearer_token' | undefined        | undefined          | {"accept":"application/json"} | {"accept":"application/json","Authorization":"Bearer bearerToken"}    |
|           | 'bearerToken' | 'bearer_token' | undefined        | undefined          | {}                            | {"Authorization":"Bearer bearerToken"}                                |
|           | 'bearerToken' | 'bearer_token' | undefined        | undefined          | undefined                     | {"Authorization":"Bearer bearerToken"}                                |
|           | 'bearerToken' | undefined      | ''               | ''                 | {"accept":"application/json"} | {"accept":"application/json","Authorization":"Bearer bearerToken"}    |
|           | 'bearerToken' | undefined      | ''               | ''                 | {}                            | {"Authorization":"Bearer bearerToken"}                                |
|           | 'bearerToken' | undefined      | ''               | ''                 | undefined                     | {"Authorization":"Bearer bearerToken"}                                |
|           | 'bearerToken' | undefined      | ''               | 'bearer_token_env' | {"accept":"application/json"} | {"accept":"application/json","Authorization":"Bearer bearerToken"}    |
|           | 'bearerToken' | undefined      | ''               | 'bearer_token_env' | {}                            | {"Authorization":"Bearer bearerToken"}                                |
|           | 'bearerToken' | undefined      | ''               | 'bearer_token_env' | undefined                     | {"Authorization":"Bearer bearerToken"}                                |
|           | 'bearerToken' | undefined      | ''               | undefined          | {"accept":"application/json"} | {"accept":"application/json","Authorization":"Bearer bearerToken"}    |
|           | 'bearerToken' | undefined      | ''               | undefined          | {}                            | {"Authorization":"Bearer bearerToken"}                                |
|           | 'bearerToken' | undefined      | ''               | undefined          | undefined                     | {"Authorization":"Bearer bearerToken"}                                |
|           | 'bearerToken' | undefined      | 'bearerTokenEnv' | ''                 | {"accept":"application/json"} | {"accept":"application/json","Authorization":"$env:bearerTokenEnv"}   |
|           | 'bearerToken' | undefined      | 'bearerTokenEnv' | ''                 | {}                            | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | 'bearerToken' | undefined      | 'bearerTokenEnv' | ''                 | undefined                     | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | 'bearerToken' | undefined      | 'bearerTokenEnv' | 'bearer_token_env' | {"accept":"application/json"} | {"accept":"application/json","Authorization":"$env:bearerTokenEnv"}   |
|           | 'bearerToken' | undefined      | 'bearerTokenEnv' | 'bearer_token_env' | {}                            | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | 'bearerToken' | undefined      | 'bearerTokenEnv' | 'bearer_token_env' | undefined                     | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | 'bearerToken' | undefined      | 'bearerTokenEnv' | undefined          | {"accept":"application/json"} | {"accept":"application/json","Authorization":"$env:bearerTokenEnv"}   |
|           | 'bearerToken' | undefined      | 'bearerTokenEnv' | undefined          | {}                            | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | 'bearerToken' | undefined      | 'bearerTokenEnv' | undefined          | undefined                     | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | 'bearerToken' | undefined      | undefined        | ''                 | {"accept":"application/json"} | {"accept":"application/json","Authorization":"Bearer bearerToken"}    |
|           | 'bearerToken' | undefined      | undefined        | ''                 | {}                            | {"Authorization":"Bearer bearerToken"}                                |
|           | 'bearerToken' | undefined      | undefined        | ''                 | undefined                     | {"Authorization":"Bearer bearerToken"}                                |
|           | 'bearerToken' | undefined      | undefined        | 'bearer_token_env' | {"accept":"application/json"} | {"accept":"application/json","Authorization":"$env:bearer_token_env"} |
|           | 'bearerToken' | undefined      | undefined        | 'bearer_token_env' | {}                            | {"Authorization":"$env:bearer_token_env"}                             |
|           | 'bearerToken' | undefined      | undefined        | 'bearer_token_env' | undefined                     | {"Authorization":"$env:bearer_token_env"}                             |
|           | 'bearerToken' | undefined      | undefined        | undefined          | {"accept":"application/json"} | {"accept":"application/json","Authorization":"Bearer bearerToken"}    |
|           | 'bearerToken' | undefined      | undefined        | undefined          | {}                            | {"Authorization":"Bearer bearerToken"}                                |
|           | 'bearerToken' | undefined      | undefined        | undefined          | undefined                     | {"Authorization":"Bearer bearerToken"}                                |
|           | undefined     | ''             | ''               | ''                 | {"accept":"application/json"} | {"accept":"application/json"}                                         |
|           | undefined     | ''             | ''               | ''                 | {}                            | undefined                                                             |
|           | undefined     | ''             | ''               | ''                 | undefined                     | undefined                                                             |
|           | undefined     | ''             | ''               | 'bearer_token_env' | {"accept":"application/json"} | {"accept":"application/json"}                                         |
|           | undefined     | ''             | ''               | 'bearer_token_env' | {}                            | undefined                                                             |
|           | undefined     | ''             | ''               | 'bearer_token_env' | undefined                     | undefined                                                             |
|           | undefined     | ''             | ''               | undefined          | {"accept":"application/json"} | {"accept":"application/json"}                                         |
|           | undefined     | ''             | ''               | undefined          | {}                            | undefined                                                             |
|           | undefined     | ''             | ''               | undefined          | undefined                     | undefined                                                             |
|           | undefined     | ''             | 'bearerTokenEnv' | ''                 | {"accept":"application/json"} | {"accept":"application/json","Authorization":"$env:bearerTokenEnv"}   |
|           | undefined     | ''             | 'bearerTokenEnv' | ''                 | {}                            | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | undefined     | ''             | 'bearerTokenEnv' | ''                 | undefined                     | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | undefined     | ''             | 'bearerTokenEnv' | 'bearer_token_env' | {"accept":"application/json"} | {"accept":"application/json","Authorization":"$env:bearerTokenEnv"}   |
|           | undefined     | ''             | 'bearerTokenEnv' | 'bearer_token_env' | {}                            | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | undefined     | ''             | 'bearerTokenEnv' | 'bearer_token_env' | undefined                     | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | undefined     | ''             | 'bearerTokenEnv' | undefined          | {"accept":"application/json"} | {"accept":"application/json","Authorization":"$env:bearerTokenEnv"}   |
|           | undefined     | ''             | 'bearerTokenEnv' | undefined          | {}                            | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | undefined     | ''             | 'bearerTokenEnv' | undefined          | undefined                     | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | undefined     | ''             | undefined        | ''                 | {"accept":"application/json"} | {"accept":"application/json"}                                         |
|           | undefined     | ''             | undefined        | ''                 | {}                            | undefined                                                             |
|           | undefined     | ''             | undefined        | ''                 | undefined                     | undefined                                                             |
|           | undefined     | ''             | undefined        | 'bearer_token_env' | {"accept":"application/json"} | {"accept":"application/json","Authorization":"$env:bearer_token_env"} |
|           | undefined     | ''             | undefined        | 'bearer_token_env' | {}                            | {"Authorization":"$env:bearer_token_env"}                             |
|           | undefined     | ''             | undefined        | 'bearer_token_env' | undefined                     | {"Authorization":"$env:bearer_token_env"}                             |
|           | undefined     | ''             | undefined        | undefined          | {"accept":"application/json"} | {"accept":"application/json"}                                         |
|           | undefined     | ''             | undefined        | undefined          | {}                            | undefined                                                             |
|           | undefined     | ''             | undefined        | undefined          | undefined                     | undefined                                                             |
|           | undefined     | 'bearer_token' | ''               | ''                 | {"accept":"application/json"} | {"accept":"application/json","Authorization":"Bearer bearer_token"}   |
|           | undefined     | 'bearer_token' | ''               | ''                 | {}                            | {"Authorization":"Bearer bearer_token"}                               |
|           | undefined     | 'bearer_token' | ''               | ''                 | undefined                     | {"Authorization":"Bearer bearer_token"}                               |
|           | undefined     | 'bearer_token' | ''               | 'bearer_token_env' | {"accept":"application/json"} | {"accept":"application/json","Authorization":"Bearer bearer_token"}   |
|           | undefined     | 'bearer_token' | ''               | 'bearer_token_env' | {}                            | {"Authorization":"Bearer bearer_token"}                               |
|           | undefined     | 'bearer_token' | ''               | 'bearer_token_env' | undefined                     | {"Authorization":"Bearer bearer_token"}                               |
|           | undefined     | 'bearer_token' | ''               | undefined          | {"accept":"application/json"} | {"accept":"application/json","Authorization":"Bearer bearer_token"}   |
|           | undefined     | 'bearer_token' | ''               | undefined          | {}                            | {"Authorization":"Bearer bearer_token"}                               |
|           | undefined     | 'bearer_token' | ''               | undefined          | undefined                     | {"Authorization":"Bearer bearer_token"}                               |
|           | undefined     | 'bearer_token' | 'bearerTokenEnv' | ''                 | {"accept":"application/json"} | {"accept":"application/json","Authorization":"$env:bearerTokenEnv"}   |
|           | undefined     | 'bearer_token' | 'bearerTokenEnv' | ''                 | {}                            | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | undefined     | 'bearer_token' | 'bearerTokenEnv' | ''                 | undefined                     | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | undefined     | 'bearer_token' | 'bearerTokenEnv' | 'bearer_token_env' | {"accept":"application/json"} | {"accept":"application/json","Authorization":"$env:bearerTokenEnv"}   |
|           | undefined     | 'bearer_token' | 'bearerTokenEnv' | 'bearer_token_env' | {}                            | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | undefined     | 'bearer_token' | 'bearerTokenEnv' | 'bearer_token_env' | undefined                     | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | undefined     | 'bearer_token' | 'bearerTokenEnv' | undefined          | {"accept":"application/json"} | {"accept":"application/json","Authorization":"$env:bearerTokenEnv"}   |
|           | undefined     | 'bearer_token' | 'bearerTokenEnv' | undefined          | {}                            | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | undefined     | 'bearer_token' | 'bearerTokenEnv' | undefined          | undefined                     | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | undefined     | 'bearer_token' | undefined        | ''                 | {"accept":"application/json"} | {"accept":"application/json","Authorization":"Bearer bearer_token"}   |
|           | undefined     | 'bearer_token' | undefined        | ''                 | {}                            | {"Authorization":"Bearer bearer_token"}                               |
|           | undefined     | 'bearer_token' | undefined        | ''                 | undefined                     | {"Authorization":"Bearer bearer_token"}                               |
|           | undefined     | 'bearer_token' | undefined        | 'bearer_token_env' | {"accept":"application/json"} | {"accept":"application/json","Authorization":"$env:bearer_token_env"} |
|           | undefined     | 'bearer_token' | undefined        | 'bearer_token_env' | {}                            | {"Authorization":"$env:bearer_token_env"}                             |
|           | undefined     | 'bearer_token' | undefined        | 'bearer_token_env' | undefined                     | {"Authorization":"$env:bearer_token_env"}                             |
|           | undefined     | 'bearer_token' | undefined        | undefined          | {"accept":"application/json"} | {"accept":"application/json","Authorization":"Bearer bearer_token"}   |
|           | undefined     | 'bearer_token' | undefined        | undefined          | {}                            | {"Authorization":"Bearer bearer_token"}                               |
|           | undefined     | 'bearer_token' | undefined        | undefined          | undefined                     | {"Authorization":"Bearer bearer_token"}                               |
|           | undefined     | undefined      | ''               | ''                 | {"accept":"application/json"} | {"accept":"application/json"}                                         |
|           | undefined     | undefined      | ''               | ''                 | {}                            | undefined                                                             |
|           | undefined     | undefined      | ''               | ''                 | undefined                     | undefined                                                             |
|           | undefined     | undefined      | ''               | 'bearer_token_env' | {"accept":"application/json"} | {"accept":"application/json"}                                         |
|           | undefined     | undefined      | ''               | 'bearer_token_env' | {}                            | undefined                                                             |
|           | undefined     | undefined      | ''               | 'bearer_token_env' | undefined                     | undefined                                                             |
|           | undefined     | undefined      | ''               | undefined          | {"accept":"application/json"} | {"accept":"application/json"}                                         |
|           | undefined     | undefined      | ''               | undefined          | {}                            | undefined                                                             |
|           | undefined     | undefined      | ''               | undefined          | undefined                     | undefined                                                             |
|           | undefined     | undefined      | 'bearerTokenEnv' | ''                 | {"accept":"application/json"} | {"accept":"application/json","Authorization":"$env:bearerTokenEnv"}   |
|           | undefined     | undefined      | 'bearerTokenEnv' | ''                 | {}                            | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | undefined     | undefined      | 'bearerTokenEnv' | ''                 | undefined                     | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | undefined     | undefined      | 'bearerTokenEnv' | 'bearer_token_env' | {"accept":"application/json"} | {"accept":"application/json","Authorization":"$env:bearerTokenEnv"}   |
|           | undefined     | undefined      | 'bearerTokenEnv' | 'bearer_token_env' | {}                            | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | undefined     | undefined      | 'bearerTokenEnv' | 'bearer_token_env' | undefined                     | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | undefined     | undefined      | 'bearerTokenEnv' | undefined          | {"accept":"application/json"} | {"accept":"application/json","Authorization":"$env:bearerTokenEnv"}   |
|           | undefined     | undefined      | 'bearerTokenEnv' | undefined          | {}                            | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | undefined     | undefined      | 'bearerTokenEnv' | undefined          | undefined                     | {"Authorization":"$env:bearerTokenEnv"}                               |
|           | undefined     | undefined      | undefined        | ''                 | {"accept":"application/json"} | {"accept":"application/json"}                                         |
|           | undefined     | undefined      | undefined        | ''                 | {}                            | undefined                                                             |
|           | undefined     | undefined      | undefined        | ''                 | undefined                     | undefined                                                             |
|           | undefined     | undefined      | undefined        | 'bearer_token_env' | {"accept":"application/json"} | {"accept":"application/json","Authorization":"$env:bearer_token_env"} |
|           | undefined     | undefined      | undefined        | 'bearer_token_env' | {}                            | {"Authorization":"$env:bearer_token_env"}                             |
|           | undefined     | undefined      | undefined        | 'bearer_token_env' | undefined                     | {"Authorization":"$env:bearer_token_env"}                             |
|           | undefined     | undefined      | undefined        | undefined          | {"accept":"application/json"} | {"accept":"application/json"}                                         |
|           | undefined     | undefined      | undefined        | undefined          | {}                            | undefined                                                             |
|           | undefined     | undefined      | undefined        | undefined          | undefined                     | undefined                                                             |

## ensureHttpAcceptHeader(headers?: Record<string, string>)

These are the functional requirements for function `ensureHttpAcceptHeader`.

| test name | headers          | ensureHttpAcceptHeader                            |
| --------- | ---------------- | ------------------------------------------------- |
|           | undefined        | { accept: 'application/json, text/event-stream' } |
|           | {}               | { accept: 'application/json, text/event-stream' } |
|           | httpHeadersBase  | expectedHttpHeadersBase                           |
|           | httpHeadersJson  | expectedHttpHeadersFull                           |
|           | httpHeadersEvent | expectedHttpHeadersFull                           |

```typescript before
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
```

## hasRequiredAcceptTokens(acceptTokens: string)

These are the functional requirements for function `hasRequiredAcceptTokens`.

| test name | acceptTokens                          | hasRequiredAcceptTokens |
| --------- | ------------------------------------- | ----------------------- |
|           | ''                                    | false                   |
|           | 'application/json, text/event-stream' | true                    |
|           | 'text/event-stream, application/json' | true                    |
|           | 'APPLICATION/JSON, TEXT/EVENT-STREAM' | true                    |
|           | 'TEXT/EVENT-STREAM, APPLICATION/JSON' | true                    |
|           | 'application/json'                    | false                   |
|           | 'text/event-stream'                   | false                   |
|           | 'text/html, image/png'                | false                   |

### Found Bugs

1. There is no check that the values are delimited by comma.

| test name                  | acceptTokens                        | hasRequiredAcceptTokens |
| -------------------------- | ----------------------------------- | ----------------------- |
| [bug] Invalid Content-Type | 'application/jsontext/event-stream' | false                   |

The function should return `false`, but currently is returing `true`.

Note: The test is currently skipped.

## parseCommandString(commandString: string)

These are the functional requirements for function `parseCommandString`.

| test name               | commandString           | parseCommandString        |
| ----------------------- | ----------------------- | ------------------------- |
| Basic command           | 'ls'                    | ['ls']                    |
| Command with options    | 'ls -la'                | ['ls', '-la']             |
| Command with argument   | 'git status'            | ['git', 'status']         |
| Leading/Trailing spaces | ' echo hello '          | ['echo', 'hello']         |
| Double quotes           | "'quoted string'"       | ['quoted string']         |
| Single quotes           | '"my program" --run'    | ['my program', '--run']   |
| Nested quotes (S in D)  | '"It\'s a test"'        | ["It's a test"]           |
| Nested quotes (D in S)  | "'Say \"Hello\"'"       | ["Say \"Hello\""]         |
| Mixed tokens            | 'cmd \'arg 1\' "arg 2"' | ['cmd', 'arg 1', 'arg 2'] |
| Escaped backslash       | 'C:\\\\Windows'         | ['C:\\Windows']           |
| Unclosed quote          | 'echo \'hello'          | ['echo', 'hello']         |
| Empty string            | ''                      | []                        |
| Only spaces             | ' '                     | []                        |

### Possible bugs

1. Maybe an escaped space should not be considered a valid delimiter.

Currently we have:

| test name     | commandString    | parseCommandString   |
| ------------- | ---------------- | -------------------- |
| Escaped space | 'file\ name.txt' | ['file', 'name.txt'] |

Note: The test is currently skipped.

## normalizeLogging(logginValue?: { daemon?: { enabled?: boolean; }; })

These are the functional requirements for function `normalizeLogging`.

| test name        | logginValue               | normalizeLogging          |
| ---------------- | ------------------------- | ------------------------- |
| no daemon        | undefined                 | undefined                 |
| daemon undefined | {daemon: undefined}       | undefined                 |
| daemon enabled   | {daemon: {enabled: true}} | {daemon: {enabled: true}} |

### Found bugs

1. The value of enabled should be a `boolean`.

| test name                      | logginValue  | normalizeLogging           |
| ------------------------------ | ------------ | -------------------------- |
| [bug] undefined daemon enabled | {daemon: {}} | {daemon: {enabled: false}} |

---

```typescript mocks
vi.mock('./env.js', async () => {
  const m = vi.importActual('./env.js');
  return {
    ...m,
    expandHome: vi.fn((input: string) => input),
  };
});

vi.mock('./lifecycle.js', async () => {
  const m = vi.importActual('./lifecycle.js');
  return {
    ...m,
    resolveLifecycle: (name: string, rawLifecycle: RawLifecycle | undefined, command: CommandSpec) => ({
      mode: rawLifecycle,
    }),
  };
});
```

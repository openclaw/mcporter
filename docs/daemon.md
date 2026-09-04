---
summary: 'Single-user daemon, immutable configuration views, exclusive existing-Chrome ownership, and deliberate migration.'
read_when:
  - 'Configuring keep-alive servers, the daemon, serve mode, or Chrome DevTools'
---

# Single-user daemon

The daemon owns keep-alive MCP transports across ordinary CLI invocations. Its production locator is the OS account's home directory, under `.mcporter/daemon/user.sock`. Configuration filenames, working directories, HOME, and XDG overrides do not select another production daemon. The host starts without loading a caller's keep-alive list. Project idle settings do not shut down this shared host.

Clients resolve their own configuration and imports, then register an immutable view. Calls identify the daemon generation, opaque view handle, and local server alias. Replacing a configuration registers another view without replacing the host or disturbing calls already using the previous view. List and serve visibility are local to that view; the host checks tool filters again on direct calls. Releasing a view or exiting a CLI does not close the shared transport. Abandoned views expire after 15 minutes; active requests retain their view. The host bounds views and transports and refuses excess registrations rather than retaining unlimited state.

Equivalent definitions share a connection independently of their aliases, descriptions, source filenames, and tool filters. Effective executable, ordered arguments, cwd, environment, protocol/client identity, HTTP options, and credential ownership remain part of connection identity. HTTP/authenticated aliases retain separate credential identities. Explicit environment values override inherited values before identity is computed. Environment maps travel with transport setup rather than being installed into the host's shared process environment. OAuth vaults, legacy caches, refresh locks, browser suppression, and timeouts are scoped to each connection's async context.

For generic stdio, inherited `PWD` is set to the actual child cwd and inherited shell nesting (`SHLVL`) is omitted; changing only the caller's directory or adding a shell launcher does not split a fixed launch context. Explicitly configured `PWD` or `SHLVL`, other environment values, executable/arguments and actual child cwd remain meaningful. HTTP aliases are a conservative exception to alias-independent pooling: each alias remains its existing credential owner, even when OAuth is inferred later and the URL/headers match. Such aliases use separate MCP sessions.

## Commands and status

```sh
mcporter daemon start
mcporter daemon status
mcporter daemon status --json
mcporter daemon stop
mcporter daemon restart
mcporter daemon migrate
```

Status describes the global host. JSON includes `pid`, `protocolVersion`, `generation`, `views`, and `servers`. Each connection has a non-secret `connectionId`, `connectionGeneration`, `connected`, `activeCalls`, and `lastUsedAt`. `browserOwner`, when present, identifies its connection and state. Opaque connection identifiers deliberately do not reveal environment values, credentials, child arguments, or URLs. The socket is mode 0600 in an owner-only mode 0700 directory. Windows uses a user/namespace-specific named pipe and a protected, verified current-user-only directory ACL. Both platforms authenticate the host and client with fresh, connection-bound HMAC challenges before transmitting resolved configuration. An impostor listener cannot obtain the configuration. No key is sent over the socket or pipe.

`stop` drains admission and refuses to close while calls remain active. Retry stop after those calls finish. Ordinary clients never request a shared server restart in response to a failed call. Protocol errors, daemon-generation changes, and expired handles are returned to the caller; an uncertain request is not replayed against a replacement host.

Ordinary application errors and timeouts leave healthy connections intact. A timeout has an unknown outcome and is never replayed. After a definitive transport close, the host retires the old transport and its owned process tree before creating a new connection generation. Concurrent callers serialize behind that reconnect. A retirement failure blocks replacement instead of allowing overlapping children. An unexpected daemon-process exit leaves metadata that blocks automatic replacement: an operator must verify its transports have retired before clearing stale state.

Generic keep-alive transports honor `lifecycle.idleTimeoutMs` after all queued and active calls finish. Different idle policies use separate transports. Expiry retires the owned process tree; the next explicit call creates one new connection generation. Chrome owners stay retained across idle gaps. An unknown-outcome timeout also blocks automatic idle retirement until a definitive disconnect/recovery or deliberate operator stop. Status reports `servers[].idleTimeoutMs` and, when applicable, `idleBlocked` (`browser-owner` or `unknown-outcome`).

Only `daemonIdleTimeoutMs` in the selected canonical user config controls automatic host shutdown. Project/explicit caller settings do not control it. The host may stop after the configured inactivity period only when no active calls, reserved Chrome owner, unknown outcomes or failed retirements remain. Status exposes the canonical `idleTimeoutMs` and `idleShutdownBlocked`. Explicit generic/test namespaces have no canonical-user idle authority; per-server idle expiry still applies there.

## Existing Chrome ownership

All recognizable Chrome DevTools launch definitions are treated conservatively as one existing-local-Chrome ownership domain. A browser owner is reserved synchronously before discovery, relay authentication, or child launch. Equivalent definitions join that owner. Incompatible pending or live definitions receive `browser_owner_conflict`; this error is non-retryable and leaves the owner intact.

The host reads canonical global policy before accepting requests. It uses normal global-file precedence in the OS-account context: `.mcporter/mcporter.json`, then `.mcporter/mcporter.jsonc`, selecting only the first existing file. Caller XDG overrides do not select canonical authority; alternate `.config` files are not additional owners. Nonstandard global locations require operator reconciliation before cutover. Home expansion and placeholders use the canonical account context.

Applicable supported auto-connect definitions constrain the complete canonical connection contract. Genuinely conflicting applicable definitions are refused. Unrelated isolated/unsupported Chrome definitions do not poison a supported owner; those unsupported definitions are refused if requested. The owner launches with its retained canonical environment. Caller shell/GUI environment differences do not change that context. The same requested executable name uses the canonical PATH resolution, including for a GUI caller with no PATH. Explicit requested env (including PATH), executable, arguments, cwd, authentication, endpoint and security settings must match the canonical contract. Caller relay/OpenClaw process controls cannot rewrite it; put intended controls in the canonical definition itself. An explicit temporary config, caller HOME, or process-level `off` cannot weaken canonical `require`.

Supported auto-connect commands use the relay implementation. Under shared ownership both `require` and `prefer` fail closed if relay authentication or handoff fails: neither silently starts direct remote debugging. Direct auto-connect with `off` requires explicit matching canonical configuration. Logical discovery endpoint, keyId rotation and security settings participate in retained ownership; changes return a conflict while leaving the owner untouched. Direct browser URLs, direct WebSocket endpoints, unsupported wrappers, and profile labels are refused by this candidate because they do not prove a different browser identity. The same conservative refusal also applies to ostensibly remote or isolated Chrome definitions until distinct identity can be established. Programmatic/ephemeral Chrome transports must use the daemon-backed runtime or fail explicitly before attachment.

**One retained connection is one shared MCP session.** Chrome tools that rely on selected-page state do not provide per-caller isolation. Selecting a page in one caller can change the target of another caller's later operation. Transport pooling and tool filters do not solve that protocol limitation. The host serializes individual tool calls. Select-then-act sequences still span multiple calls: callers must coordinate access and verify targets. Per-view filters do not create independent page selections. Generic stateful MCP servers likewise retain their shared session semantics.

A healthy retained connection avoids reattachment between ordinary invocations. A crash, deliberate restart, migration, or explicit recovery can still require another browser permission prompt.

## Deliberate migration from per-config daemons

Older per-config daemons are an incompatible live ownership contract. The candidate scans known daemon directories for legacy metadata and probes live owners. A live or unverified legacy process blocks startup. The candidate does not silently kill a process, fall back to the legacy protocol, or claim to transfer a stdio/CDP connection.

1. Upgrade **all** invoking clients and generated bundles. Old binaries cannot honor the new ownership lock.
2. Stop admitting old work and wait for legacy calls to complete.
3. Inspect `mcporter daemon migrate`; output reports legacy PIDs and whether their socket identity was verified.
4. After independently confirming the drain, run:

   ```sh
   mcporter daemon migrate --stop-legacy --confirmed-drained
   ```

5. The migration command waits for the verified old host and its observed, same-user child tree to retire, using process start identities to distinguish PID reuse. An interrupted or unsuccessful retirement leaves a marker that blocks new startup; rerunning migration rechecks retirement. Resolve unverified ownership manually. The command never signals a PID taken only from metadata.

Legacy daemons in nonstandard historic namespaces must be inventoried by the operator. Mixed old/new clients and unidentified legacy namespaces cannot provide universal exclusive ownership.

Process-query failures and unverified owner or start identities block retirement. Empty or malformed helper output is never accepted as proof of exit. Windows observations query owners only for the selected process tree; retirement polls target the captured PIDs and preserve start identities to detect reuse.

## Explicit test namespaces

`MCPORTER_DAEMON_DIR=/absolute/private/directory` preserves intentional isolation. Each explicit directory has its own `daemon/user.sock` and `daemon/user.json`, within that generic/test namespace. Use a short, mode-0700 temporary directory for fixtures and set HOME/XDG to throwaway locations as well. `daemon stop` in that namespace affects only that namespace.

This is an explicit exception to OS-user singleton scope for generic transports. Existing-local-Chrome requests outside the canonical OS-user namespace are refused before discovery or child launch, so this setting cannot create a second supported Chrome owner. Synthetic Chrome tests substitute an isolated OS-account home inside the test harness; there is no production environment flag to bypass the namespace restriction. HOME/XDG overrides alone are **not** test isolation for daemon operations.

## Serve and generated entrypoints

`mcporter serve --stdio` and `mcporter serve --http <port>` register the caller's view. `--servers` selects visible aliases, and per-view filters constrain tool advertisements and calls. A generated keep-alive runtime registers its definitions through the same broker. Generated bundles include the broker management entrypoint and can cold-start the same user daemon. They register embedded definitions in memory without writing generated configuration files. Raw programmatic Chrome transport calls fail explicitly; use a daemon-backed runtime.

Generation's schema discovery also uses the broker for keep-alive servers. Generated templates and bundles embed the generating MCPorter version for their default MCP client identity, matching ordinary invocations of that version. Explicit custom client identities remain separate pooling inputs; existing Chrome requires the canonical MCPorter identity. Regenerate bundles when upgrading invoking clients.

`--log` and `--log-file` record bounded operation events. Status includes the redacted relay decision. Child diagnostics and provider log bodies are suppressed in the shared host to avoid credential or unrelated-session disclosure. Live cutover still requires upgraded clients, verified retirement, and operator validation.

## Relay authentication and protected child handoff

MCPorter requires an OpenClaw relay that implements **Browser Relay Authentication v2**, including the connection-bound challenge, completion, authenticated `/json/version`, and same-connection `/cdp` upgrade sequence. An older OpenClaw relay is unsupported: `require` and shared-owner `prefer` fail with `unsupported-auth`; neither launches the original Chrome `--autoConnect` path. MCPorter never retries an old Bearer, Basic, or raw-token relay handshake, even when the v2 endpoint returns `404`, `401`, or `426`, a proof fails, or the handshake times out. During OpenClaw's dual-stack migration window, legacy acceptance exists only for older clients; current MCPorter always uses v2.

The mode-`0600`, current-user relay key never enters an HTTP header, URL, WebSocket subprotocol, application frame, child command line, or child environment. MCPorter derives its non-secret `keyId`, connects once to a numeric loopback address, verifies the connected peer, and keeps that exact raw TCP socket from the HMAC challenge through completion, `/json/version`, and the `/cdp` WebSocket upgrade. It does not follow redirects, reconnect, re-resolve, or hand the key to the proxy. Only after both server proofs verify does MCPorter start a short-lived downstream proxy bound strictly to `127.0.0.1`; that proxy wraps the already-authenticated and already-upgraded socket rather than opening another upstream connection.

The same raw client supports the protocol's separate `json-list` flow: it authenticates one `/json/list` request on the retained socket, reads a bounded response, and closes instead of upgrading.

Each downstream proxy retains the protections introduced for the child handoff: it gets a fresh 256-bit authorization bearer, MCPorter writes that ephemeral value to an exclusively created mode-`0600` file inside a mode-`0700` temporary directory, and only the protected file path reaches a Node preload through the child environment. The preload validates and consumes the file, removes the handoff variable, and appends `--wsHeaders` only to JavaScript's `process.argv`; the OS command line contains only the credential-free loopback WebSocket endpoint. The proxy accepts exactly one authorized downstream WebSocket, synthesizes that child's `101` response, and then bridges frames to the retained upstream socket. Losing either side retires the proxy and its authenticated connection.

The preload composes with existing `NODE_OPTIONS`, including MCPorter's separate Chrome compatibility preload. The proxy, handoff file, preload, and temporary directory are closed or removed on normal shutdown, setup failure, abort, and negotiation retry. On POSIX systems, ownership and permissions are checked before the handoff is consumed. On Windows, MCPorter creates the temporary directory atomically with a verified current-user-only ACL before its path exists; setup fails closed if that security descriptor cannot be established. Plaintext relay URLs remain limited to loopback, including custom URLs set with `MCPORTER_CHROME_DEVTOOLS_RELAY_URL`; remote HTTP relay targets and URLs containing credentials are rejected.

Choose routing with `chromeDevtoolsRelay` (or `chrome_devtools_relay`) on the server definition, or override it for the process with `MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY`:

- `prefer` is the default. Under shared ownership it attempts the v2 extension relay and fails with operator guidance if authentication or handoff fails. It never falls back to legacy relay authentication or direct auto-connect.
- `require` fails before any legacy auto-connect process is launched if the endpoint, credential, probe, authentication, extension connection, local proxy, or protected handoff is unavailable. Retries remain fail-closed.
- `off` disables relay probing and rewriting. The older `MCPORTER_DISABLE_CHROME_DEVTOOLS_RELAY=1` switch remains an alias for `off`.

```jsonc
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest", "--autoConnect"],
      "lifecycle": "keep-alive",
      "chromeDevtoolsRelay": "require",
    },
  },
}
```

Before probing, MCPorter runs the non-secret `openclaw browser extension cdp --json` metadata command without the legacy-bearer option. POSIX launches `openclaw` directly. Windows resolves an existing `openclaw.cmd` only from safe absolute `PATH` entries, rejects the current directory and command-expanding path bytes, then passes the quoted absolute shim plus constant arguments to a validated system `cmd.exe`. Process spawning always keeps `shell: false`; time and combined output are bounded, and timeout or overflow terminates the full Windows process tree through the validated system `taskkill.exe`. Fallback diagnostics never include stdout or stderr. MCPorter accepts only the exact loopback Browser Relay Authentication v2 CDP contract whose `keyId` matches the local relay credential. An explicit nonempty `MCPORTER_CHROME_DEVTOOLS_RELAY_URL` remains authoritative and skips metadata discovery; unavailable, timed-out, malformed, unsafe, or incompatible metadata falls back to `http://127.0.0.1:18799`. Relay control and OpenClaw discovery variables in a server definition's `env` map use the same placeholder resolution as its runtime transport and override process-level values for both routing and daemon identity.

Metadata discovery and the authenticated `/json/version` probe each use the relay timeout, which is 5 seconds by default. `MCPORTER_CHROME_DEVTOOLS_RELAY_TIMEOUT_MS` accepts milliseconds, clamped to 100–30000; unset, zero, non-integer, and otherwise invalid values use 5000. Credential discovery follows OpenClaw: `OPENCLAW_OAUTH_DIR` wins, then `OPENCLAW_STATE_DIR`; otherwise credentials live under the effective home in `.openclaw/credentials`, or `.openclaw-<profile>/credentials` for a validated non-default `OPENCLAW_PROFILE`. Explicit `OPENCLAW_HOME` takes precedence over `HOME` and `USERPROFILE`.

Relay ownership uses the shared effective-settings resolver: policy/default timeout spellings, equivalent URLs, default profiles and fully overridden process inputs normalize consistently with routing. The retained identity includes the logical endpoint, credential directory, v2 protocol marker, keyId and discovery/security inputs. Key rotation or changed discovery identity returns an owner conflict; it never replaces the host automatically. The legacy per-config freshness/restart mechanism no longer applies.

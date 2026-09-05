---
summary: 'Behavior and architecture of mcporter generate-cli, including outputs, runtimes, regeneration, and policy boundaries.'
read_when:
  - 'Changing generate-cli behavior or bundler integrations'
---

# CLI Generator

`mcporter generate-cli` produces a standalone CLI for one MCP server. Tool schemas become subcommands and schema fields become positional arguments or flags. By default, the command writes `<server>.ts` in the working directory. Bundling is opt-in via `--bundle`; Rolldown handles Node.js output, while Bun’s native bundler handles Bun output. Use `--bundler` to override that choice.

## Notes

- Generated CLI depends on the latest `commander` for argument parsing.
- Default timeout for tool calls is 30 seconds, overridable via `--timeout`.
- Runtime flag remains (`--runtime bun`) to tailor shebang/usage instructions, but Node.js is the default.
- Generated CLI embeds the resolved server definition and always targets that snapshot (no external `--config` or `--server` overrides at runtime). Discovery uses that same definition, so an explicit `--command` or inline `--server` remains authoritative when generation also receives `--config`.
- Schema property names become long flags: `QueryText` becomes `--query-text`, repeated separators collapse, and names made only of separators use `--option`. Collisions receive numeric suffixes in schema order, skipping both existing flags and Commander storage keys. Use the generated help to find the assigned spelling; calls retain the original JSON property names.
- A schema flag such as `--no-cache` takes an explicit value and is not a negated Commander option. Nullable arrays keep their item types and enum choices.

## Usage Examples

```bash
# Minimal: infer the name from the command URL and emit TypeScript (optionally bundle)
npx mcporter generate-cli \
  --command https://mcp.context7.com/mcp \
  --minify

# Provide explicit name/description and compile a Bun binary (falls back to Node if Bun missing)
npx mcporter generate-cli \
  --name context7 \
  --command https://mcp.context7.com/mcp \
  --description "Context7 docs MCP" \
  --runtime bun \
  --compile

chmod +x context7
./context7
  # show the embedded help + tool list

# Shareable "one weird trick" for chrome-devtools (no config required)
npx mcporter generate-cli --command "npx -y chrome-devtools-mcp@latest"
```

- `--minify` shrinks the bundled output via the selected bundler (output defaults to `<server>.js`).
- `--compile [path]` implies bundling and invokes `bun build --compile` to create the native executable (Bun only). When you omit the path, the compiled binary inherits the server name.
- Use `--server '{...}'` when you need advanced configuration (headers, env vars, stdio commands, OAuth metadata).
- Omit `--name` to let mcporter infer it from the command URL (for example, `https://mcp.context7.com/mcp` becomes `context7`).
- When targeting an existing config entry, you can skip `--server` and pass the name as a positional argument:
  `npx mcporter generate-cli linear --bundle dist/linear.js`.
- When the MCP server is a stdio command, you can also skip `--command` by quoting the inline command as the first positional argument (e.g., `npx mcporter generate-cli "npx -y chrome-devtools-mcp@latest"`).
- Generated CLIs preserve `lifecycle: "keep-alive"` for embedded stdio servers. Schema discovery and runtime calls register immutable views with the single-user daemon, without writing generated configuration files. Default MCP client identity embeds the generating MCPorter version, so equivalent ordinary/generated invocations of that version reuse the same retained connection. Existing Chrome still requires the canonical global owner configuration; see [daemon ownership](daemon.md#existing-chrome-ownership).
- Narrow the CLI to a specific subset of tools with `--include-tools`:
  `npx mcporter generate-cli linear --include-tools issues_list,issues_create`.
- Hide debug or admin tools with `--exclude-tools`:
  `npx mcporter generate-cli linear --exclude-tools debug_tool,admin_reset`.

## Artifact Metadata & Regeneration

- Every generated artifact embeds its metadata (generator version, resolved server definition, invocation flags). A hidden `__mcporter_inspect` subcommand prints the payload without contacting the MCP server, so binaries remain self-describing even after being copied to another machine.
- `mcporter inspect-cli <artifact>` shells out to that embedded command and prints a human summary (pass `--json` for raw output). The summary includes a ready-to-run `generate-cli` command you can reuse directly.
- `mcporter generate-cli --from <artifact>` replays the stored invocation against the latest mcporter build. `--server`, `--runtime`, `--timeout`, `--minify/--no-minify`, `--bundle`, `--compile`, `--output`, and `--dry-run` let you override specific pieces of the stored metadata when necessary.
- Because the metadata lives inside the artifact, any template, bundle, or compiled binary can be refreshed after a generator upgrade without juggling sidecar files.

## Policy boundary for generated CLIs

A generated CLI or typed client can be invoked independently of the MCP client
that originally configured the server. It therefore does not automatically
inherit that client's approval prompts, tool-call policies, or audit trail.

Use `--include-tools` to reduce the generated surface, but do not treat a static
tool list as dynamic authorization. Deployments that need per-call policy should
route the generated command through an external wrapper or policy gateway that:

1. normalizes the server, tool name, and arguments;
2. evaluates current policy and requests approval when required;
3. blocks the call or invokes the generated CLI; and
4. persists a redacted decision and result record.

Conceptual wrapper pseudocode (not a built-in mcporter API):

```ts
const operation = normalize({ server, tool, arguments });
let decision;
let outcome = 'evaluation_failed';
let result;
let failure;

try {
  decision = await gateway.evaluate(operation);

  if (decision.action === 'block') {
    outcome = 'blocked';
    failure = 'policy_block';
    throw new Error(decision.reason);
  }

  if (decision.action === 'approve' && !(await approvals.confirm(decision))) {
    outcome = 'approval_declined';
    failure = 'approval_declined';
    throw new Error('Approval declined');
  }

  try {
    result = await generatedCli.call(tool, arguments);
    outcome = 'succeeded';
    return result;
  } catch (error) {
    outcome = 'execution_failed';
    failure = classifyError(error);
    throw error;
  }
} catch (error) {
  failure ??= classifyError(error);
  throw error;
} finally {
  await audit.append(redact({ operation, decision, outcome, result, failure }));
}
```

The `finally` path records a redacted outcome for blocked requests, declined
approvals, policy-evaluation failures, execution failures, and successful calls.
The wrapper governs only calls routed through it. Direct execution of the
generated artifact bypasses that policy boundary.

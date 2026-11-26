---
summary: 'Start a cloud Android phone, act on its screen and delete it through an isolated HTTP MCP configuration.'
read_when:
  - 'Testing an Android or iOS app from a script or agent without a local emulator or Mac'
---

# Mobilebox cloud phones

[Mobilebox](https://mobilebox.dev/docs) runs cloud Android phones and iOS simulators that an agent drives over Streamable HTTP: create a phone, read its screen as a numbered element list, tap, type and install apps, then delete it. Unlike the keyless examples, it needs an API key: sign up at [mobilebox.dev/signup](https://mobilebox.dev/signup) (new accounts get $2 of credit, no card) and export it as `MOBILESANDBOX_API_KEY`. A running phone costs $0.01 a minute, billed per second, so delete it when you're done.

The [example configuration](https://github.com/openclaw/mcporter/blob/main/examples/mobilebox/mcporter.json) registers a `mobilebox` server that reads the key from the environment and disables editor imports. Passing it explicitly with `--config` keeps these commands separate from your project and user configuration. If the variable is unset, `list` shows the tools as unavailable.

## Run from a checkout

Use Node 24 or 26 and the pnpm version declared in `package.json`. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
export MOBILESANDBOX_API_KEY=...
node dist/cli.js --config examples/mobilebox/mcporter.json list mobilebox --schema
```

Create a phone. It comes back ready, with its id and the first screen:

```sh
node dist/cli.js --config examples/mobilebox/mcporter.json call mobilebox.create_phone \
  --args '{"name":"mcporter-example"}'
```

```text
ph_km257oxpjhhv "mcporter-example" ready

app: com.android.launcher3
[1] List #com.android.launcher3:id/workspace (540,1200)
...
```

Open Settings and wait for a label, then delete the phone:

```sh
node dist/cli.js --config examples/mobilebox/mcporter.json call mobilebox.act \
  --args '{"phone_id":"ph_km257oxpjhhv","actions":[{"type":"open_app","package":"com.android.settings"},{"type":"wait_for","text":"Network"}]}'

node dist/cli.js --config examples/mobilebox/mcporter.json call mobilebox.delete_phone \
  --args '{"phone_id":"ph_km257oxpjhhv"}'
```

`act` runs up to 20 actions in order (`tap`, `type`, `swipe`, `open_app`, `wait_for`, …) and returns the new screen; target elements by their text, e.g. `{"type":"tap","target":{"text":"Battery"}}`. For an iPhone simulator pass `{"platform":"ios"}` to `create_phone`. Add `--output json` when processing results in a script.

## Use your own configuration

Copy the `mobilebox` server entry into your existing `mcpServers` map and keep your existing `imports` setting. mcporter resolves `${MOBILESANDBOX_API_KEY}` when the transport runs and stops with the variable name if it is unset.

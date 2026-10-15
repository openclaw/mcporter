---
summary: 'Query FXMacroData macroeconomic indicators and release calendars through an isolated HTTP MCP configuration.'
read_when:
  - 'Pulling official macroeconomic data or upcoming release times into a script or agent'
---

# FXMacroData macro data

[FXMacroData](https://fxmacrodata.com/documentation/mcp-server) serves central-bank and statistics-agency data (policy rates, inflation, payrolls, GDP, bond yields and release calendars) over Streamable HTTP. USD tools work without an API key; on the keyless tier a new USD release becomes readable 15 minutes after it is published, and history covers the last 90 days. Other currencies return a `subscription_required` result until a key is supplied.

The [example configuration](https://github.com/openclaw/mcporter/blob/main/examples/fxmacrodata/mcporter.json) registers an `fxmacrodata` server and disables editor imports. Passing it explicitly with `--config` keeps these commands separate from your project and user configuration.

## Run from a checkout

Use Node 24 or 26 and the pnpm version declared in `package.json`. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
node dist/cli.js --config examples/fxmacrodata/mcporter.json list fxmacrodata --schema
```

Get the latest value of every USD indicator, then the recent history of one series and the upcoming USD release schedule:

```sh
node dist/cli.js --config examples/fxmacrodata/mcporter.json call fxmacrodata.latest_announcements \
  --args '{"currency":"usd"}'

node dist/cli.js --config examples/fxmacrodata/mcporter.json call fxmacrodata.indicator_query \
  --args '{"currency":"usd","indicator":"inflation","limit":12}'

node dist/cli.js --config examples/fxmacrodata/mcporter.json call fxmacrodata.release_calendar \
  --args '{"currency":"usd","indicator":"non_farm_payrolls"}'
```

`indicator_query` rows carry the reference period (`date`), the value (`val`) and publication timing for each print, newest first; follow `partial_page.next_call` for older pages. Without a key only the last 90 days come back, so a monthly series such as inflation returns about three prints even with `"limit":12`. `release_calendar` returns `announcement_datetime` in UTC; pass `"timezone":"Europe/London"` (any IANA name) for an extra local timestamp. Use `list fxmacrodata --schema` for the accepted indicator slugs, and add `--output json` when processing results in a script.

## Use your own configuration

Copy the `fxmacrodata` server entry into your existing `mcpServers` map and keep your existing `imports` setting. Without a key, the entry above is enough for USD.

For other currencies, add an API key from an environment variable. mcporter resolves the placeholder when the transport runs and stops with the variable name if it is unset:

```json
{
  "mcpServers": {
    "fxmacrodata": {
      "baseUrl": "https://mcp.fxmacrodata.com/mcp",
      "headers": { "Authorization": "Bearer ${FXMACRODATA_API_KEY}" }
    }
  }
}
```

Keys are available from the [FXMacroData subscribe page](https://fxmacrodata.com/subscribe).

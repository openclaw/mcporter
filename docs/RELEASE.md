---
summary: 'Release checklist for mcporter: versioning, tests, build artifacts, npm publish, GitHub release assets, and Homebrew tap updates.'
read_when:
  - 'Cutting a release or updating release automation'
---

# Release Checklist

> **Runner note:** From the repo root run `export MCP_RUNNER="$PWD/runner"` and use `$MCP_RUNNER <command>` for every shell command listed below unless the step explicitly says otherwise. This keeps the guardrails active even when the checklist jumps between directories.

> **Helper script:** You can run `./scripts/release.sh <phase>` (gates | artifacts | publish | smoke | tag | all) to execute the steps below with the runner by default. It stops on first error; rerun the next phase after fixing issues.

> **No-warning policy:** Every command below must finish without warnings (Oxfmt, Oxlint, tsgo, Vitest, npm pack, etc.). Fix issues before continuing; releases cannot ship with outstanding warnings.

## Definition of “released”

Shipping a release means **all** of:

- Tag pushed (`v<version>`).
- npm published (`mcporter@<version>` visible via `npm view mcporter version`).
- GitHub release published for the tag **with assets + checksums**.
- Homebrew tap updated (and verified) after assets propagate.

1. Update version in package.json and src/runtime.ts.
2. Run pnpm install to refresh the lockfile if dependencies changed.
3. pnpm check (zero warnings allowed; abort immediately on any error)
4. pnpm test (must finish with **0 failed**; if Vitest prints any red FAIL lines or a non-zero exit code, stop and fix it before proceeding)
5. pnpm build
6. pnpm build:bun
7. tar -C dist-bun -czf dist-bun/mcporter-macos-arm64-v<version>.tar.gz mcporter
8. shasum -a 256 dist-bun/mcporter-macos-arm64-v<version>.tar.gz | tee dist-bun/mcporter-macos-arm64-v<version>.tar.gz.sha256
9. npm pack --pack-destination /tmp && mv /tmp/mcporter-<version>.tgz . # keep the real tarball
10. shasum mcporter-<version>.tgz > mcporter-<version>.tgz.sha1 && shasum -a 256 mcporter-<version>.tgz > mcporter-<version>.tgz.sha256
11. Verify git status is clean.
12. git commit && git push.
13. pnpm publish --tag latest _(the runner already has npm credentials configured, so you can run this directly in the release shell; bump `timeout_ms` if needed because prepublish re-runs check/test/build and can take several minutes.)_
14. `npm view mcporter version` (and `npm view mcporter time`) to ensure the registry reflects the new release before proceeding. If the new version isn’t visible yet, wait a minute and retry—npm’s replication can lag briefly.
15. Sanity-check the “one weird trick” workflow from a **completely empty** directory (no package.json/node_modules) via:
    ```bash
    rm -rf /tmp/mcporter-empty && mkdir -p /tmp/mcporter-empty
    cd /tmp/mcporter-empty
    # run this without the runner because we are outside the repo and npx handles its own logging
    npx mcporter@<version> generate-cli "npx -y chrome-devtools-mcp" --compile
    ./chrome-devtools-mcp --help | head -n 5
    ```
    Only continue once the CLI compiles and the help banner prints.
16. Draft the GitHub release notes using this template (copy/paste and edit). **Title the release `mcporter v<version>` (project name + version) to keep GitHub’s releases list consistent.**

    ```markdown
    ## Highlights

    - <top feature>
    - <second feature>
    - <bugfix or UX callout>

    SHA256 (mcporter-macos-arm64-v<version>.tar.gz): `<sha from step 8>`
    SHA256 (mcporter-<version>.tgz): `<sha from npm pack>`
    ```

    Then **create the GitHub release for tag v<version>** and upload all assets:
    - `mcporter-macos-arm64-v<version>.tar.gz`
    - `mcporter-macos-arm64-v<version>.tar.gz.sha256` (from step 8; add a `.sha256` file)
    - `mcporter-<version>.tgz` (from `npm pack`)
    - `mcporter-<version>.tgz.sha1` and `mcporter-<version>.tgz.sha256`
      Double-check the uploaded checksums match your local files.

17. Tag the release (git tag v<version> && git push --tags).
18. Post-tag housekeeping: add a fresh "Unreleased" stub to CHANGELOG.md (set to "- Nothing yet.") and start a new version section for the just-released patch if it isn’t already recorded.

After the release is live, always update the Homebrew tap and re-verify both installers. The tap formula should install the npm `.tgz`, not the Bun-compiled macOS tarball, because `generate-cli --compile` needs the installed package tree so Bun can resolve `mcporter`, `commander`, and related dependencies when compiling from an empty directory. Keep the macOS tarball on the GitHub release as a direct binary asset, but point Homebrew at `mcporter-<version>.tgz`.

1. Update `steipete/homebrew-tap` -> `Formula/mcporter.rb` with:
   - URL `https://github.com/steipete/mcporter/releases/download/v<version>/mcporter-<version>.tgz`
   - SHA256 from `mcporter-<version>.tgz.sha256`
   - `require "language/node"`, `depends_on "node"`, and `system "npm", "install", *std_npm_args, "--min-release-age=0"` so same-day releases with fresh npm dependencies can install immediately.
     Refresh the tap README highlight so Homebrew users see the new version callout.
2. Commit and push the tap update.
3. Refresh and reinstall from the real tap:
   ```bash
   brew update
   brew reinstall steipete/tap/mcporter
   brew test steipete/tap/mcporter
   /opt/homebrew/bin/mcporter --version
   ```
4. Run a Homebrew-installed empty-directory compile smoke:
   ```bash
   rm -rf /tmp/mcporter-brew-smoke && mkdir -p /tmp/mcporter-brew-smoke
   cd /tmp/mcporter-brew-smoke
   /opt/homebrew/bin/mcporter generate-cli "npx -y chrome-devtools-mcp" --compile
   ./chrome-devtools-mcp --help | head -n 5
   ```
5. Install the npm package globally (or leave it to npx) and verify that path too:
   ```bash
   npm install -g mcporter@<version>
   mcporter --version
   npx --yes mcporter@<version> --version
   ```
6. If installing on another Mac, repeat the real tap reinstall and compile smoke there:
   ```bash
   brew update
   brew reinstall steipete/tap/mcporter
   /opt/homebrew/bin/mcporter --version
   ```

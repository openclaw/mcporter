---
summary: 'Serialized release checklist for exact-tag native proof, GitHub, npm, and Homebrew publication.'
read_when:
  - 'Cutting a release or updating release automation'
---

# Release Checklist

Official release order is fixed: source gates → signed tag → local signed/notarized native artifacts → protected draft verification → GitHub publication → npm publication → Homebrew dispatch. Never publish a later stage when an earlier proof is missing.

v0.12.3's standalone arm64 binary is not a continuity baseline: it was ad-hoc `a.out`, had no Developer ID team, failed strict signature verification, and its checksum named a build-directory path. v0.12.4 starts the native trust contract below.

## Trust boundary

- Ordinary `pnpm build:bun` and CI builds are credential-free and are never official Darwin release artifacts.
- Official native artifacts are produced locally through `release-mac-app`'s managed `codesign-run`; do not put the Developer ID key or notarization credentials in GitHub Actions.
- Required identity: `Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)`; identifier: `org.openclaw.mcporter`.
- Required signing: hardened runtime, secure timestamp, and only `allow-jit` plus `allow-unsigned-executable-memory` Bun entitlements.
- Standalone CLI binaries must embed the exact designated requirement and pass strict Developer ID metadata plus the online `notarized` codesign constraint. macOS 26.5 does not treat a raw CLI as an app for `spctl --assess --type execute`, so raw-binary `spctl` success is neither required nor mocked. The final Gatekeeper proof is naturally quarantined execution without an alert on each clean native-architecture VM; `spctl`, `syspolicy_check`, and stapling remain applicable to future `.app`, `.dmg`, or `.pkg` targets.
- `NOTARYTOOL_KEYCHAIN_PROFILE` names a pre-existing local profile. It is injected only at the serialized native gate; no preparation/build/test step retrieves it.
- The verifier job grants its built-in `github.token` only `contents: write`, which GitHub requires for draft visibility. That token exists only in the exact draft-download step; the verifier explicitly rejects `GH_TOKEN` and `GITHUB_TOKEN` before it executes the package or either native candidate. No repository release-token secret is used.
- `.github/workflows/release-assets.yml` and `.github/workflows/update-homebrew-tap.yml` must be dispatched from the repository's current default branch. Both reject a mismatched workflow ref.
- Release automation accepts stable `vMAJOR.MINOR.PATCH` tags only; prereleases require a separate dist-tag-aware contract before they can enter this pipeline.

## 1. Credential-free preparation

1. Update `package.json` and `CHANGELOG.md`; contributor work must keep its changelog thanks and commit `Co-authored-by` trailer.
2. Run:

   ```bash
   ./scripts/release.sh gates
   ```

3. Require zero warnings/failures from formatting, lint, typecheck, tests, Node build, ordinary Bun build, release contract mocks, and `pnpm audit`.
4. Review the complete diff, run autoreview to a clean result, commit, push, and wait for exact-head CI.
5. From clean current `main`, create and push a signed annotated `v<version>` tag only after the serialized tag gate. The tag commit must remain the current protected default-branch commit for native verification.

## 2. Local native package gate

This step is secret-bearing and must wait for the exact-tag serialized release gate. It requires Apple Silicon plus Rosetta, the canonical managed Foundation release keychain supplied at runtime, and the existing notary profile name:

```bash
export NOTARYTOOL_KEYCHAIN_PROFILE='<existing-profile-name>'
./scripts/release.sh native
```

`scripts/release.sh` finds `mac-release` on `PATH` or in a sibling `agent-scripts` checkout; set `MAC_RELEASE_HELPER=/absolute/path/to/mac-release` for another layout. The release helper wraps `scripts/package-release.sh` in `codesign-run`. Packaging refuses a dirty tree, a tag/HEAD mismatch, an untrusted tag signature, the wrong Developer ID identity, or an existing output directory. It deletes ignored `dist/`, rebuilds it from the exact tag, requires every declared CLI/library entry, packs without lifecycle repacking, and verifies this exact inventory in `dist-release/`:

- `mcporter_<version>_darwin_arm64.tar.gz`
- `mcporter_<version>_darwin_x86_64.tar.gz`
- `mcporter-<version>.tgz`
- `checksums.txt`
- `provenance.json`

Checksums contain basenames only. The npm tarball must expose its declared executable, library, and type entries; verification installs that exact tarball into an isolated project from a blank npm config, then runs the installed CLI and imports its public library with isolated HOME/XDG roots. This proves dependency closure without borrowing checkout `node_modules`. The x86_64 payload uses Bun's baseline target so it does not require AVX. Both native archives contain exactly one executable named `mcporter`; each must pass strict exact embedded designated-requirement, identifier/team/authority, hardened-runtime, timestamp, exact-entitlement, online notarization constraint, architecture, and `--version` checks. Run `./scripts/release.sh verify-local` to repeat that proof with GitHub tokens removed. At the gated clean-VM stage, download each published archive through the browser so quarantine is applied, then require first execution and `--version` to complete without a Gatekeeper alert on matching arm64 and x86_64 hosts.

## 3. Protected draft verification

1. Create a draft GitHub release for the already-pushed signed tag. Upload exactly the five local files above; keep the release unpublished.
2. Dispatch **Verify Release Assets** from the current default branch with input `tag=v<version>`.
3. Record the workflow run ID. Both the arm64 and x86_64 jobs must succeed.

The workflow checks out its protected current workflow commit with persisted credentials disabled, configures the repository-owned SSH allowed-signers file, requires exact tag/HEAD/clean-tree proof, finds exactly one draft through paginated REST release lookup, rejects extra or missing assets, and downloads each asset by its exact REST asset ID. Verification runs in the following step with GitHub tokens absent. Each successful native job preserves its architecture plus the release ID, asset IDs, sizes, and SHA-256 digests as a workflow proof artifact. Publication requires both arm64 and x86_64 artifacts and requires their complete verified asset sets to match, so a partial matrix rerun cannot silently replace one architecture's proof.

Do not publish GitHub, npm, or Homebrew before both native jobs succeed.

## 4. Serialized publication

1. Publish the already-verified GitHub draft without changing its tag or asset inventory.
2. Publish npm only through the proof-gated phase:

   ```bash
   NATIVE_VERIFIER_RUN_ID=<run-id> ./scripts/release.sh publish-npm
   ```

   This repeats local native verification, checks the exact successful protected workflow run, downloads and cross-checks both architecture proof artifacts, re-downloads every published asset by REST ID, and requires every digest to match the protected draft proof. It publishes the exact verified npm tarball, tolerates registry propagation after a successful publish, and verifies immutable registry integrity before continuing.

3. Verify registry metadata:

   ```bash
   npm view mcporter@<version> version dist-tags.latest dist.tarball dist.integrity time
   ./scripts/release.sh smoke
   ```

4. Dispatch **Update Homebrew Tap** from the current default branch with `tag=v<version>` and the same `native_verifier_run_id`. The workflow rechecks npm, the exact native proof SHA/title/workflow, both architecture manifests, and every published GitHub byte against the preserved proof. It computes SHA-512 integrity from the verified GitHub npm tarball and requires npm `dist.integrity` plus `latest` to match before dispatching. Its token is scoped only to those dispatch/wait steps.

## 5. Downstream verification and closeout

After the tap workflow succeeds:

```bash
brew update
brew reinstall steipete/tap/mcporter
brew test steipete/tap/mcporter
/opt/homebrew/bin/mcporter --version
```

Then run the Homebrew-installed empty-directory `generate-cli --compile` smoke and verify `npm view` still reports the expected version, dist-tag, tarball, integrity, and publish time. The Homebrew formula intentionally remains on the npm package tree so generated CLI compilation can resolve package dependencies; changing that is outside this release.

Finally add the next patch `Unreleased` changelog stub, commit/push it, pull `main --ff-only`, and leave the checkout clean.

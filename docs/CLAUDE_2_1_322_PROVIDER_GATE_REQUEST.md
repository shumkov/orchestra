# Claude .283/.322 provider request — pending explicit go

This is a local request draft, not authorization. No provider calls, real authentication changes, issue publication, pin changes, release or activation have occurred.

## Concrete preparation completed

Related Polygram child: /Users/ivanshumkov/orca/workspaces/polygram/claude-322-gates, branch claude-322-gates, base 960b0be3b191f5a336bab8d5d6577d411c548a3a. Parent piddock and its dependencies remain untouched. Included project-local consent works for both binaries under the isolated no-provider harness. Both then report explicit Channels-unavailable output before the turn sender and exit BLOCKED (2). No account/feature success was fabricated. Remaining local error modes and mailbox were not retried against that same missing prerequisite.

Supported Channels needs authorized Anthropic authentication plus feature availability (and organization enablement where applicable); a development custom-server flag is insufficient. Candidate also tests allow_channels. Official sources: [Channels](https://code.claude.com/docs/en/channels), [development flag](https://code.claude.com/docs/en/channels-reference#test-during-the-research-preview), [included consent](https://code.claude.com/docs/en/settings-reference#skipdangerousmodepermissionprompt).

The child now supports an absolute --manifest selector, exact-content child hash binding and an enforced discovery stage. Its separate claude-2.1.322-discovery.json holds explicitly provisional candidate hypotheses; default accepted manifest and SDK .283 are unchanged. Discovery is restricted to --version candidate and cannot accept artifacts. See the child's docs/claude-322-discovery-dossier.md for every candidate key's provenance and unknowns. Final independent review receipts are recorded in the followup report.

## Minimal request for Ivan

Authorize a dedicated gate-only Anthropic account/credential context with Channels and Workflow available, kept in a synthetic private HOME rather than the real login, and authorize one candidate-only discovery batch: at most 13 scenario invocations, once each, with existing 15-minute child deadlines (195 minutes aggregate plus startup/cleanup overhead). This includes the CLI contract twice, eleven other cells once, Opus Workflow projection and snapshot legs; internal retries/nested calls mean it is not an API-request, token or dollar bound. Stop on the first failure, ambiguity or authorization problem; no automatic paid reruns. Confirm an account context compatible with the declared Workflow default; do not invent Pro/non-Pro status.

Before execution, the coordinator must provide the authorized private credential environment and review the necessary provider/control network allowlist while retaining denial of real user config and Keychain access. No real login mutation is included. Retain the actual checked runner/driver timeouts and per-driver turn limits. The manifest's cost.usdEstimate fields are estimates, not enforcement; no repository-mandated monetary ceiling was found in AGENTS.md or these checked drivers. No additional spending-cap, metering-proxy or whole-run watchdog project is a mandatory prerequisite.

After observation review, separately authorize one authoritative 23-run old/new comparison (10 old + 13 candidate, 345 minutes of child deadlines plus overhead), on one recorded immutable gate commit with a separately reviewed acceptance manifest. No discovery result can authorize pin edits. An actual-new-SDK validation batch is subsequent work after that accepted comparison and reviewed aligned pin change; its final cases need review then. SDK staging and CLI soaks are separate future authorizations.

## Commands prepared for the coordinator; do not execute yet

Fish variables for exact preserved binaries:

```fish
set old_bin /Users/ivanshumkov/.local/share/orchestra-upgrade-preservation/claude-2.1.283-to-2.1.322-darwin-arm64/claude-2.1.283
set candidate_bin /tmp/orchestra-claude-upgrade-research-3agLJs/candidate/package/claude
set discovery_manifest /Users/ivanshumkov/orca/workspaces/polygram/claude-322-gates/scripts/spikes/claude-2.1.322-discovery.json
set gate_artifacts /ABSOLUTE/PRIVATE/MODE-0700/ARTIFACT-DIRECTORY
set gate_run claude-283-322-RECORDED-GATE-COMMIT

# From the isolated Polygram child, after explicit go and reviewed isolated
# credential/network environment. No secrets in argv, logs or git.
node scripts/spikes/run-claude-gate-matrix.mjs --manifest $discovery_manifest --old-bin $old_bin --candidate-bin $candidate_bin --artifact-base $gate_artifacts --run-prefix $gate_run-discovery --version candidate

# Later, after observation review and separate explicit go, use a distinct
# reviewed acceptance manifest on the recorded immutable gate commit:
set acceptance_manifest /ABSOLUTE/PATH/TO/REVIEWED-ACCEPTANCE-MANIFEST.json
node scripts/spikes/run-claude-gate-matrix.mjs --manifest $acceptance_manifest --old-bin $old_bin --candidate-bin $candidate_bin --artifact-base $gate_artifacts --run-prefix $gate_run
```

The acceptance manifest does not exist yet. Commands above describe invocation/time scope; the runner stops on first failure and has per-child timeouts, not a guaranteed aggregate cleanup limit. Do not call --accept-run until complete authoritative PASS, independent evidence review and separate destructive-cleanup authorization. Retain all current evidence.

Record exact gate commit, manifest/driver/binary hashes, version readback and clean gate-owned state before/after any approved batch. This worker leaves all changes uncommitted for integration. The tracking issue remains a draft, not an opened issue; issue publication and the successful accepted matrix must precede pins. Aligned reviewed Orchestra SDK/CLI pins, reviewed actual-pair behavior, separately reviewed consumer update, Linux rollback binaries and both mandatory 24h staging/CLI soaks remain outstanding.

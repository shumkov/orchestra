# Claude Code 2.1.283 compatibility

Orchestra 0.11.0 pins the channels backend to Claude Code 2.1.283. The pin is
now defined by the Agent SDK: `@anthropic-ai/claude-agent-sdk` 0.3.283 is
pinned exactly, `CLAUDE_CLI_PINNED_VERSION` must equal its `claudeCodeVersion`
(a unit test enforces it), and the vendored binary is copied from the SDK's
per-platform package. On darwin-arm64 that binary is byte-identical to the
auto-updater's 2.1.283 (SHA-256 `d8cb1e5c…1d21e`, same Anthropic signature).

## Behavior changes handled

- **Workspace trust dialog.** 2.1.283 lists "❯ No, exit" first and pre-selects
  it; Enter exits claude. The dialog can also render before it accepts input.
  The startup gate now presses Down until "❯ Yes, I trust this folder" is
  visibly selected, then Enter. Not in the upstream changelog; found by a live
  probe.
- **System prompt recording** (2.1.267+). A conversation records its appended
  system prompt once and replays it on resume until compaction. `CliProcess`
  passes `--system-prompt-snapshot off` when `--help` lists it, so display
  rules and the reply contract rebuilt on each spawn reach resumed chats.
  2.1.220 rejects the flag, so it is feature-detected once per binary. Tool
  definitions stay recorded even with the snapshot off.
- **Opus 5.5** is what `--model opus` resolves to (2.1.280).

## Live probes (2.1.283, real sessions through `CliProcess`)

| Probe | Result |
|---|---|
| Footer while streaming | `esc to interrupt` present in 14 of 16 mid-turn captures; `STREAMING_HINT_RE` unchanged |
| Footer with a background shell | `⏵⏵ bypass permissions on · 1 shell`; `BACKGROUND_SHELL_RE` extracts 1 |
| Dangerous `rm` in bypass mode, 4 triggers | Triggers 1–3 show "Do you want to proceed?" with an auto-deny countdown and are denied after ~2 min (129–148 s); the turn continues and replies. Trigger 4 is denied without a dialog (14 s) after 3 unanswered prompts. No approval card is emitted; the dialog only produces `cli-mid-turn-unknown-prompt` telemetry. |
| Trust dialog | Handled by the new gate (see above) |
| Session-age dialog | Option order unchanged ("Resume from summary" first); `CLAUDE_CODE_RESUME_THRESHOLD_MINUTES` still present, so the dialog stays suppressed |
| Rollback direction | 2.1.220 resumes a session written by 2.1.283 and recalls its context |

## Known upstream regression: auto-backgrounded MCP calls (SDK)

With `CLAUDE_AUTO_BACKGROUND_TASKS=1`, 2.1.283 moves a slow MCP tool call to
the background after about 1 s, ends the turn, then reports the background
task as `failed`; every retry returns "The tool call was interrupted before a
result was received" (3 of 3 gate runs; 2.1.220 completes it). Without the
opt-in, which is how production runs, the call stays in the foreground and
completes (2 of 2 runs plus the authoritative matrix). Do not enable
`CLAUDE_AUTO_BACKGROUND_TASKS` on this pin. The gate records this cell as a
known regression for 2.1.283 and keeps gating the foreground path.

## Known limitation: long working directories

Claude Code truncates the `~/.claude/projects/<encoded-cwd>` directory name at
about 200 characters and appends a short hash (observed on 2.1.220, e.g.
`…-workflow-workspace--d9uh4m`). Orchestra's and Polygram's session-log path
helpers assume the plain encoding, so session-log reading fails for a cwd whose
encoded name exceeds that length. Production cwds are far shorter; the gate
must run with a short artifact base.

## Compatibility gate

Polygram's serial real-Claude matrix (2.1.220 ↔ 2.1.283, run
`2026-09-26T16-30-19-568Z`) passed all 22 authoritative runs and was accepted:

- two independent CLI contract runs per version;
- direct and failed-reply Workflow completion delivery;
- delayed MCP completion on the default (foreground) path;
- SDK PostToolBatch, subagent, resume, manual compact, and tool-less drain;
- the candidate Opus 5.5 production projection;
- the candidate system-prompt snapshot cell: with recording forced on the
  resumed session kept the first prompt, and with `--system-prompt-snapshot
  off` it saw the changed prompt, so recording is active for the account and
  the flag is what keeps prompt changes reaching resumed chats.

Two cells are waived and listed in every summary: the
`CLAUDE_AUTO_BACKGROUND_TASKS=1` delayed-MCP path (a 2.1.283 regression, see
above; intermittent on 2.1.220; unused in production).

2.1.283 lifecycle differences the matrix declares per version: an extra
UserPromptSubmit hook for a prompt folded into a running turn; eight passive
context attachments recorded once per session (counted, position-free, since
their order against the first queued message is a race); an `auto_mode`
attachment in Opus sessions; new `atis-latch` and `cost-state` transcript rows;
SDK `tool_progress` heartbeats and a variable number of `status` notices.
`total_tokens_reminder` attachments appear on both versions.

Acceptance note: the run's evidence tree held one hook ndjson a late hook had
recreated as 0644 after the session was torn down (fixed in this release:
the hook helper now creates files 0600). It was set to 0600 before
acceptance; its content is outside the evaluated evidence.

## Rollback

Reinstall the previous Orchestra/Polygram. Boot deletes every vendored version
except the pin, so preserve the 2.1.220 binary outside the vendor directory
before deploying and copy it back before restarting the old version.

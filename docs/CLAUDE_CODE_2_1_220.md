# Claude Code 2.1.220 compatibility

Orchestra 0.6.0 pins the channels backend to Claude Code 2.1.220. The pin is
deliberate because the backend consumes private Claude Code TUI, hook, session,
queue, and MCP-registration behavior.

The upgrade was validated against the preserved 2.1.173 binary with Polygram's
serial real-Claude matrix. All 21 cells passed:

- two independent CLI contract runs per version;
- direct and failed-reply Workflow completion delivery;
- delayed MCP completion;
- SDK PostToolBatch, subagent, resume, manual compact, and tool-less drain;
- the 2.1.220 Opus 5/default-Workflow production projection.

The candidate takes longer than five seconds on some cold starts to send its
first MCP `ListToolsRequest` after the channels bridge authenticates. Orchestra
therefore keeps the authenticated bridge alive and allows up to 30 seconds for
MCP readiness, while still failing immediately on disconnect.

Rollback remains possible by selecting the preserved 2.1.173 executable with
`ORCHESTRA_CLAUDE_BIN`. The normal default resolves and vendors 2.1.220.

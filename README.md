# Emberforge

A GitHub-compatible git forge that runs as a single Node process: git smart HTTP
(upload-pack protocol v2, receive-pack v0), the REST v3 surface (repos, branches,
commits, contents, issues, labels, pull requests with squash merge), GraphQL v4
with introspection, and an MCP endpoint — all over one in-memory, deterministic
store. No git binary, no dependencies beyond the Node standard library.

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/zamrdzhu/emberforge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/zamrdzhu/emberforge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty
(github-core-clone-01, $500 in USDC). Local trials with the official suite:
120/120 conformance checks, performance 187/200.

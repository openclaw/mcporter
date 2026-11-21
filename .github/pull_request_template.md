<!--
Optional linked context:
Add a visible `Closes #<issue-number>` or `Related: #<issue-number>` line
below this comment.

Write for someone who uses MCPorter but has not read the code. The title and
opening problem statement should make sense without the diff or linked issue.

Suggested title: type: <what changes for the person affected>
Use a parenthesized scope only when it helps that reader. Name the affected
task and the symptom or outcome, not just the implementation.

Illustrative wording, not claims about current bugs:
Good: fix: explain which arguments to change when an MCP tool call is rejected
Bad: fix(cli): adjust schema coercion error handling
Good: docs: help developers generate a CLI from an MCP server
Bad: docs: update the generator reference

For internal-only work, name the actual developer or operator workflow affected.
-->

## What Problem This Solves

<!--
Describe the concrete user, product, or operational problem.
In 1–3 plain sentences, say who is affected, what happens today, and why it
matters to them. For a bug, name the trigger if known. For a feature or internal
work, describe the need in the actual workflow without inventing harm.
Could a reader understand the problem without knowing your proposed fix?

Good: "Background checks can use up a new user's model allowance before they've
asked the assistant to monitor anything."
Bad: "Turn off periodic checks on fresh installs."
-->

## User Impact

<!--
Lead with what users, operators, or developers can now do or expect, usually
in one plain-language sentence. For internal-only changes, say there is no
user-visible change; do not invent a benefit. Keep important risks, breaking
changes, migrations, and required user actions visible here.
-->

## Why This Change Was Made

<!--
Briefly explain how the change addresses the problem without repeating the impact.
Keep the body short. Leave file lists, internal acronyms, and root-cause walkthroughs
in the diff or optional <details>; include technical detail only when it explains
behavior or a material tradeoff. Do not hide risks or required actions in <details>.
-->

## Evidence

<!--
Start with the behavior checked and the result in plain language. For example,
explain whether a CLI call, config import, OAuth flow, generated CLI, or TypeScript
client behaved as expected, as relevant to the change. Distinguish local fixture
tests from live-server checks, and state meaningful gaps or checks not run.

Focused tests, CI results, terminal output, redacted logs, screenshots, and artifact
links can support the result. Put exact commands, commit hashes, and long output
in links or optional <details>; do not make readers decode a command list to learn
what was verified. Never include credentials or private MCP server data.
-->

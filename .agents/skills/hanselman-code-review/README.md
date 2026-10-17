# Hanselman Code Review Skill

ClawSweeper is the authoritative source of the
[Hanselman adversarial review skill](https://github.com/shanselman/hanselman-code-review-skill).
This copy was adopted from
[Windows Node at 4244a480](https://github.com/openclaw/openclaw-windows-node/tree/4244a48069e2d96ac6c68f0b4801c5f6d1ec1278/.agents/skills/hanselman-code-review).
All future changes belong here, not in independently maintained consumer copies.

Ask for a "Hanselman review", "adversarial review" or "dual-model review" in
the Copilot app. Follow [SKILL.md](SKILL.md) and [contract.json](contract.json)
for exact scope, models/settings, identical reviewer prompts, reconciliation
and confidence assessment. Neither a Codex CLI nor a Claude CLI is required
for interactive use. Hosted execution uses the Copilot SDK.

For each admitted Windows Node PR review, hosted ClawSweeper runs its normal
assessment first, then automatically runs Hanselman using that assessment's
requested actions and proof gaps as identical evidence for both reviewers.
It publishes one combined result through the normal durable comment path.
Automatic-review cadence is unchanged; ordinary `/review` also includes this
stage on Windows Node PRs. `/review hanselman` remains an explicit maintainer
alias. Other repositories and ordinary issue triage remain unchanged.

Finding confidence, proposed-fix confidence and PR readiness stay separate.
The combined result preserves normal findings, proof obligations and next steps;
Hanselman can add findings or lower ratings, not clear baseline blockers.

Repeat reviews target changed code and unresolved findings where possible.
Unavailable models/settings, either failed reviewer, invalid reconciliation
or source drift cannot produce a clean consensus. Source-review agreement
does not replace runtime proof.

## Consumer follow-up

In a separate Windows Node change, replace its maintained skill directory
with a reference to this directory at a reviewed ClawSweeper commit, or use
an explicit installation/update procedure that copies this entire directory
(including contract and license) from that pinned commit without local edits.
Record the consumed revision and direct changes upstream here. Do not install
from a PR head or an unpinned moving URL. No other repository was changed by
this adoption.

## License

[MIT](LICENSE.md), copyright Scott Hanselman.

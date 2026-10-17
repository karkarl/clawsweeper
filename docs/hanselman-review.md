# Hanselman review

- Status: active implementation; hosted rollout requires authorized canary proof
- Owner: ClawSweeper maintainers
- Source of truth: `.agents/skills/hanselman-code-review/`, `src/review-strategy.ts`,
  `src/hanselman-*.ts`, and the exact-review command intake
- Last verified: implementation based on `959b5ad440794bb53a012b7ed6f6b406c4fc1c3f`;
  hosted availability is not yet verified
- Update when: skill contract, model access, invocation, or execution changes

## Ownership and invocation

ClawSweeper owns the [skill](../.agents/skills/hanselman-code-review/SKILL.md),
its [execution contract](../.agents/skills/hanselman-code-review/contract.json),
README and Scott Hanselman's MIT license. Instructions were adopted from
[Windows Node at 4244a480](https://github.com/openclaw/openclaw-windows-node/tree/4244a48069e2d96ac6c68f0b4801c5f6d1ec1278/.agents/skills/hanselman-code-review).
Hosted instructions and interactive skill behavior use this maintained contract.

Every admitted `openclaw/openclaw-windows-node` PR review runs the normal
ClawSweeper assessment first, followed automatically by the complementary
Hanselman stage. This includes the first automatic review and later authorized
ordinary `/review` requests. Existing admission, quiet-time and repeat-review
rules still apply: a scheduled sweep without an admitted review does not start
another Hanselman review. No synthetic comment or recursive command is posted.

`/review hanselman` and `@clawsweeper review hanselman` remain explicit aliases
for maintainers with current `write`, `maintain` or `admin` permission. The queue
still rereads commands and verifies their existing authorization; ordinary
commands keep their existing authorization rules. The exact Windows Node PR
target policy selects the complementary stage, not comment text or PR-head code.
Other repositories and issues remain unchanged. The Windows Node dispatcher's
existing forwarding needs no change.

For an offline exact-item review of Windows Node, the CLI accepts
`--local-only --item-number <number> --review-strategy hanselman`.
This is not a sweep option. Hosted execution requires verified command
admission and an exact-review queue lease, not a separate Hanselman command.
Additional prompt text cannot select this strategy on another target.
Existing oversized-PR policy still blocks model review.
Oversized PRs retain their existing metadata-only policy report and repository
action restrictions; they do not launch either the normal model or Hanselman.
Hosted exact-item selection accepts `--item-number N` and singleton
`--item-numbers N` with the same queue-lease checks. Local automatic selection
waits for the actual item kind, so Windows Node issues remain ordinary reviews.

## Execution and output

After the normal assessment completes, two independent Copilot SDK sessions
start in parallel: `claude-opus-5.5`
and `gpt-6-astra`, both `high` reasoning; Astra requires `long_context`.
The coordinator uses a third, independent Astra session with the same settings.
The model catalog must support each exact model and high reasoning. Session
receipts before and after inference must confirm applied model, effort and
Astra's required context tier; inference usage must identify the requested
model. An unreported default Opus tier is recorded as `unreported`, never
claimed as applied. There is no
silent fallback or assumed numeric context window.

Both reviewers receive the same initial prompt, the completed normal
ClawSweeper assessment (including confidence, requested actions, unresolved
findings and proof gaps), exact head/base, source
inventory, changed source/related tests, caller references and base-revision
repository instructions. Source tools read only pinned Git blobs. Skill
instructions come from the trusted ClawSweeper execution checkout, never the
target PR head. SDK config discovery, repository hooks, skills, shared memory,
remote export and host tools are disabled. Neither reviewer sees its peer's
conversation. Reconciliation sees both only after both have completed.

The coordinator accounts for the complete union, with a source-backed acceptance
or rejection for every finding. It must inspect cited head files through the
source tool. ClawSweeper validates source lines, disallows dropped/duplicate
references, and derives HIGH consensus for two-model findings and LOW for
one-model findings. Disputed findings and their accepted/rejected evidence
remain in the result. Severity maps explicitly to priority: CRITICAL=P0,
HIGH=P1, MEDIUM=P2, LOW=P3. Fix confidence is a coordinator assessment, not
a model vote or a substitute for runtime proof.

The normal marker-backed publication path emits one reconciled result, with
per-model severity, source lines, suggested fixes and fix confidence. The record
includes strategy, content-addressed skill revision, exact source revisions,
shared evidence digest, model/settings/session receipts, both review scopes
and adjudications. Its evidence digest binds the normal assessment too.
The combined result retains normal findings, proof requirements and next steps,
adds accepted Hanselman findings, and reports the complementary assessment and
dispositions. Confidence scores are not averaged or raised by model agreement:
finding correctness and proposed-fix confidence are separate; the overall
confidence score cannot exceed the normal assessment's. Proof tier remains the
normal assessment's, patch/overall tiers use the lower assessment, and open
findings cap them at C. The coordinator explains remaining code, test, runtime
proof and maintainer-decision actions. Incomplete records retain requested models, observed
settings when available, skill revision and source revisions without claiming
that unavailable models ran. Strategy/skill/settings/transport identity separates the
policy cache; existing source/content/structural identities bind revisions.
Later ordinary Windows Node PR reviews still include Hanselman by repository
policy; replacing or clearing a command does not remove the complementary stage.

Repeat reviews use the verified prior reviewed head when locally available
and an ancestor: changed code, affected callers/tests and prior unresolved or
disputed findings. Missing history explicitly selects full scope. Model-only
changes with an unchanged head focus on unresolved findings and risk decisions.

## Resources, failures and safeguards

The existing queue still admits and cancels one exact item; this is not a new
backlog or shard lane. A lease runs the normal model assessment and then at most
three Copilot sessions, with only the two independent reviewers concurrent.
One-third of the remaining item timeout is reserved for the normal assessment.
Of the time left afterward, two-thirds is reserved for parallel review and the
remainder for reconciliation; the item deadline is not multiplied. Each Copilot
session is capped at 30 AI credits, 80 source
reads and 2 MiB of read source. Each reviewer may return at most 40 findings.
The existing item result/output budget bounds the combined result. The isolated
worker is stopped on timeout/cancellation and its temporary state is removed.

No dedicated `CLAWSWEEPER_HANSELMAN_TOKEN` means incomplete, not a clean review.
This secret must provide Copilot model access; workflow App/state tokens are
not used as inference credentials. The runtime uses isolated SDK state and no
ambient user login. Missing model access, unsupported/ignored settings, a failed
reviewer, invalid/partial reconciliation, scan refusal or source/output limits
also fail explicitly. The existing source/publication guards reject or
supersede stale-head results. Never publish an available reviewer's output as
if it were consensus. Inference/configuration failures are terminal for that
attempt rather than automatically repeating the more expensive strategy.
The normal assessment is retained as partial evidence when the complementary
stage fails, but the combined result is failed/incomplete, not clean or ready.
If the normal assessment fails, Hanselman does not start; existing retryable
normal-model failures retain their retry behavior. In either case,
source-drift requeues still follow the existing command lifecycle.

The strategy never closes an item or grants repair/merge authority. CI and
current-head Windows, UI, MCP and Gateway proof requirements are unchanged.

## Rollout and consumer follow-up

Before deployment, provision the dedicated inference secret through the normal
secret process and obtain authorization for one controlled Windows Node canary.
Record actual catalog/settings receipts, source and skill revisions, latency,
credits, reconciled result and current-head publication. No live review or
GitHub metadata change is authorized by this implementation alone.

The implementation host initially lacked Docker and Crabbox on PATH. Local
focused tests are supporting evidence only, not Docker-backed runtime or hosted
model proof. A hosted canary remains blocked until dedicated model access and
explicit canary authorization are available.

Windows Node needs a separate consumer PR: remove its independently maintained
skill copy, reference this directory at a reviewed ClawSweeper commit or install
the entire directory (including contract and license) from that pin without local
edits. Record the consumed revision and route future changes here. This task
does not change another checkout or repository.

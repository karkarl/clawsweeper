# Optional target-owned review skill execution

- Status: active opt-in operator runbook; not a production rollout
- Owner: ClawSweeper review runtime maintainers
- Source of truth: `src/review-skill-config.ts`, `src/review-skill-source.ts`,
  `src/review-skill-runtime.ts`, `src/review-skill-worker.ts` and the existing
  prepared-item and managed process owners, plus
  `src/review-skill-diagnostics.ts` for safe failure summaries
- Last verified: implementation based on
  `openclaw/clawsweeper@7c6fea774ff7fc18033da68cb9d1d8872dc4bd6a`;
  actual model execution requires source-bound operator proof, not unit tests
- Update when: selection, source limits, model/settings readback, SDK version,
  process lifecycle, reconciliation, report or package contracts change

## Explicit authority, unchanged defaults

Ordinary reviews still discover read-only guidance as described in
[target repositories](target-repositories.md#repository-owned-review-skills).
Only an operator-supplied `--review-skill <slug>` **and**
`--review-skill-config <absolute-host-json>` request paid companion execution.
The config must be a regular bounded file outside the target checkout. Never
accept this selection/config from a PR body, target skill, target helper or
head-controlled workflow. The host reads the complete target
`.agents/skills/<slug>/SKILL.md` and transitive local Markdown/reference links
from the exact fetched default/main revision (the accepted base for local-range
review), not PR-head or working-tree instructions. Required references are
resolved within that skill directory, including standard inline and reference-
definition angle destinations such as `<references/review guide.md>` with spaces;
missing, escaping, non-text or oversized
files fail closed. Limits: 128 KiB/file, 512 KiB total, 24 files, 80 changed
source files and 2 MiB changed-source text. Raw Git changed-path inventories and
SDK source listings must decode losslessly as UTF-8 before any path lookup or
rendering. Unsupported byte filenames fail incomplete, never as a fabricated
deleted path; NUL framing prevents Git quoting from concealing invalid bytes. A missing/unreadable/escaping/
non-text/oversized skill or reference becomes a literal source-failure state: the
ordinary baseline still runs, then the companion is explicitly incomplete without
launching its SDK. Unknown source never supplies complete cache proof. No target
helper executes. All optional-skill Git reads use the existing trusted executable
resolver and one verified absolute host Git path, outside the target and host
checkout. Relative/dot PATH entries, checkout binaries and symlinks into either
checkout cannot select that executable; the isolated SDK worker revalidates it.

Supported owners are the normal exact PR review (local-only or an already
authorized hosted exact queue lease) and the existing local committed-range
review. Issues, multi-item sweeps and automatic scheduled selections reject
explicit execution. Hosted lease, drift, admission and publication guards stay
in force; these flags create no queue or publication authority. Metadata-only
oversized PR handling never starts inference, even with explicit selection.

## Operator execution config

The optional adapter is pinned to `@github/copilot-sdk@1.0.22`, using its bundled
stdio runtime (no FFI/native build scripts). Two distinct exact reviewer model
IDs, an explicit coordinator, reasoning effort and context tier are required;
there is no fallback. The following **example** binds the Scott skill models
through an OpenAI-compatible BYOK endpoint; production contains no Scott/target
name switch and does not copy the skill. Its full source remains target-owned.

```json
{
  "adapter": "copilot",
  "provider": {
    "baseUrl": "https://openrouter.ai/api/v1",
    "apiKeyEnv": "OPENROUTER_API_KEY"
  },
  "reviewers": [
    {"model":"anthropic/claude-opus-5.5","reasoningEffort":"high","contextTier":"default"},
    {"model":"openai/gpt-6-astra","reasoningEffort":"high","contextTier":"long_context"}
  ],
  "coordinator": {"model":"anthropic/claude-opus-5.5","reasoningEffort":"high","contextTier":"default"},
  "timeoutMs": 600000,
  "maxResultBytes": 524288
}
```

BYOK supports an explicit HTTPS OpenAI-compatible endpoint whose public
`GET /models` catalog provides exact IDs, context limits and reasoning/tool
capabilities, including `structured_outputs` and `response_format`. An
incompatible/unavailable catalog is incomplete, never invented capabilities. Only the admitted `OPENROUTER_API_KEY` or dedicated
`CLAWSWEEPER_SKILL_API_KEY` environment reference is accepted, never an inline
key or an arbitrary environment variable. Proxy/CA egress controls are retained.
For native Copilot, omit `provider`, use the operator-authorized native exact IDs
(for the Scott example: `claude-opus-5.5`, `gpt-6-astra`), and supply a dedicated
`CLAWSWEEPER_SKILL_TOKEN`. No logged-in profile or publication GitHub token is
used for inference. Renaming a publication token does not make it a dedicated
inference credential: selected token bytes are checked against all other
configured environment values before local-range credential scrubbing
and again before worker launch, excluding only the three admitted companion key
bindings. This value-level separation covers dynamically named publication tokens
without assuming that their names contain GitHub/GH/repository. Do not duplicate
the inference credential under unrelated environment names. In opted-in runs the baseline reviewer receives none of the three
companion credential variables; the isolated worker alone receives its selected
one. Ordinary non-opted-in environments remain unchanged. The native SDK model catalog is
consulted only after start.

```bash
pnpm run build
node dist/clawsweeper-local.js review --target-repo owner/repo \
  --target-dir /absolute/target/checkout --base <accepted-base-sha> \
  --review-skill <slug> --review-skill-config /absolute/host/review-skill.json
node dist/clawsweeper.js review --target-repo owner/repo --local-only \
  --item-number 123 --review-skill <slug> \
  --review-skill-config /absolute/host/review-skill.json
```

Do not put credentials in JSON, command arguments, prompts, reports or source.
The normal baseline review still needs its existing runner setup. Install the
optional dependency only through the repository lockfile/admission policy; a
missing SDK is an incomplete opted-in run, not a reason to change providers.

## Execution and readable evidence

The ordinary assessment runs first. Two independent sessions then receive
byte-identical full skill/reference text, exact head/base, pinned changed source
and baseline evidence, adapting the skill to each reviewer role. For an exact
GitHub PR, the existing Git evidence owner must establish one verified merge base
of base-tip and head; changed inventory, base reads, deleted-file verification
and receipt `baseSha` all use that introduced-patch base. Upstream-only base-tip
changes are not PR deletions. The approved skill stays pinned independently to
trusted default/main. An explicit local committed range retains its accepted
base exactly; this rule does not silently replace that owner's range semantics. The coordinator
gets the same evidence plus both complete structured results. Read-only source
and path-list tools access only bounded pinned Git objects; no shell, target
helpers, filesystem mutation, credentials or agent tools are exposed. The SDK
host approves once only the exact custom `read_source` and `list_source` tools;
all other permission kinds/tool names and every managed-policy ask are rejected.
An inspected base blob verifies a deletion only after a successful Git lookup
proves the path absent at head; base inspection never substitutes for an extant
head file.

Every SDK turn uses the same compact native strict wire schema, exactly
`{"payload":"string"}`, for every reviewer model and coordinator from the first
request. The string contains the **complete** serialized canonical role envelope:
reviewer scope plus the full host Decision, or coordinator Decision plus bounded
adjudications. The full canonical schema remains pinned in the shared prompt;
the provider enforces only the small outer grammar, not the full Decision
grammar. The host decodes the string and applies its unchanged canonical
Decision/domain, proof/owner, union/source and output-budget guards. Extra,
missing or non-string outer fields, invalid inner JSON/schema and omitted
findings fail. Coordinator `reviewFindings` must still be empty because verified
adjudications alone own those findings. One exact whole **inner** Markdown `json`
fence may be removed as mechanical framing; outside prose is rejected and the
native outer object itself must be strict JSON. This is an explicit versioned
wire contract, not a 400-triggered fallback, model substitution or retry. The
common wire instructions are included before hashing the identical reviewer
prompts, and the opt-in cache identity includes this encoding revision. The
ordinary `review_policy` remains the cadence policy even after an explicit skill
review. Existing `review_model` metadata carries a hash-bound execution identity
for opted-in reports and structural/content cache checks; it is not a new model
selection or admission rule. Different skill/reference/model/wire contracts and
ordinary-versus-skill reviews cannot reuse each other as cache proof. Legacy
ordinary records remain compatible; no Decision/record schema field is added.

The coordinator must inspect every finding file and explicitly accept/reject
every union member, including disputed and single-reviewer findings. Model-judged
issue groups contain at most one finding per reviewer; accepted duplicate groups
are emitted once at the higher severity. The readable report includes actual
model names, per-model P0-P3 severity, HIGH/LOW/disputed consensus, suggested fixes,
fix confidence (0-99%), all dispositions and inspection limits. P3-only findings
do not make a patch incorrect. User-supplied prose/table cells are escaped.

Existing `solutionAssessment` carries the run receipt: full skill/reference
hashes, source pins, identical evidence/prompt hashes, independent session IDs,
requested/applied model/reasoning/context settings, observed usage model IDs and
generic provider-kind/catalog-digest provenance. Configured provider endpoints
and internal URLs are never included in exported runtime provenance, including
when rendering an older receipt containing such fields. Before/after setting
readback and actual usage must
match exactly. Every SDK `assistant.usage` event must report both the requested
model and the requested actual `reasoningEffort`; any mismatched or unreported
actual effort fails incomplete even when configured `model.getCurrent()` still
reports the requested effort. Successful receipts/rendering include the verified
actual effort values; failure diagnostics expose only bounded effort-match status. Readback demonstrates runtime-applied settings, not an independent
measurement of provider internals or a universal context-size guarantee.

Baseline and companion proof/data-model, owner/product, security/testing, labels,
options and required next steps are conservatively retained even with zero code
findings. Existing bounded label/option/rank-up fields remain bounded; the full
union is retained visibly in assessment/rationale rather than adding persisted
Decision fields or silently discarding overflow. Merge-risk options group by the
three canonical categories: an explicit fix-before-merge recommendation survives
either pass, while accepting risk or recommending closure needs agreement from
both assessments. Conflicting recommendations remain unendorsed, not automated
acceptance or closure. All option rationales remain visible. Label justifications merge by
label identity, retaining both rationales but only the selected canonical labels;
impact/merge-risk projections stay bounded to three labels and maturity to one.
Merged provenance and low-value-test projections retain the canonical limits of
eight and ten respectively. The five-owner projection always retains the
selected required decision owner. Complete overflow stays visible in assessment
text so the durable record remains a parser fixed point. No proof or owner decision is
waived by coordinator confidence. Work recommendations are deny-wins in both
orders: `none` or `manual_review` cannot be promoted by another `queue_fix_pr`,
and typed owner/product/security blockers withhold runnable queued work even
when both work recommendations are optimistic. Inactive work prompts, files,
validation and cluster references are cleared from the runnable projection,
while both complete proposals and rationales remain visible in assessment text.
Work confidence cannot increase; implementation complexity and reproduction
certainty are combined conservatively, and `strict_bug` cannot survive another
assessment's automation veto. Incomplete companion work also withholds automatic
plans. Existing dashboard/work-plan policy owners consume the reconciled fields;
no queue control or intent classifier is added. Any explicit security item
category survives reconciliation in either order, even if that assessment's
security disposition is cleared, so the existing security-label owner still
receives the category. Companion regression assessments and a unique unverified
provenance pointer also survive for the existing host verifier; conflicting
pointers withhold predecessor attribution. Supporting-evidence projections stay
bounded to three, with complete non-attributing evidence retained in assessment.
AGENTS policy flags and status are reconciled together: disagreement never
publishes an applied-policy claim when the conservative applied flag is false.
Old records need no migration.

A deadline, unavailable/mismatched model/setting, output/source budget, omitted
union, scanner refusal or cleanup failure is explicitly **incomplete**, never
clean consensus. Source reload/scanning and model work share the worker
absolute deadline; preflight time is not granted again to model calls. Output-limit
abort promises are handled immediately and settled by owned session cleanup,
including synchronous or asynchronous abort refusals. Both independent reviewer tasks settle before ordinary teardown;
in-flight SDK startup/session acquisitions remain owned through deadline cleanup
so late sessions join the same awaited close inventory. The managed outer process
still bounds stuck SDK calls. Every session close and global shutdown is attempted; an abort,
disconnect or stop error prevents completion. A graceful SDK stop that returns
errors or rejects always triggers a force-stop attempt; a force-stop refusal
does not replace the original failure or permit a clean result. A pre-existing primary failure
keeps its identity/phase, with cleanup failures recorded separately. Baseline
evidence remains available. Companion-only scanner refusal/unavailability also
retains that baseline as an incomplete stored report, with a fresh sanitized
`AgentInputScanError` reason for existing terminal/retry classification; the
ordinary baseline scanner behavior is unchanged. Raw Git timeout/failure/overflow
results are never treated as successful empty lookups or deletions. Tool-returned
source listings, including unchanged names, pass the same scanner and cumulative
source-read budget as file content before any text reaches inference. Failure
reports expose only fixed execution phases,
whitelisted host-parser field names and bounded config-bound model/setting/usage
match summaries, never raw SDK/provider messages or model output. New host-owned review leases include the baseline, configured companion, source
preparation and supervisor/cleanup budgets. At launch, hosted execution requires
a verified current owned lease expiry. After baseline and source preparation,
the host rereads the live head, comment-lease election and exact-queue/source
authority immediately before paid companion launch. PR queue claims must carry
the exact source head; an unbound claim is refused. This applies to both acquired and
supplied leases. Lost ownership/head drift cancels only the companion; unavailable
authority is retryable incomplete work with the baseline retained. Only fixed
diagnostics cross into the report; no GitHub credentials or host callback enter
the inference worker. Baseline/source/companion work is capped
to its remaining time with a shutdown/supervision reserve. A supplied lease is
never silently extended: exhausted remaining time produces incomplete work
instead of running beyond ownership. Ordinary and local-only defaults are
unchanged. Existing managed process supervision through `src/agent-runner.ts` bounds streams/deadlines,
forces the trusted JavaScript worker through the current Node executable,
aborts/disconnects sessions and terminates
the whole process tree on timeout/cancellation (POSIX groups; Windows taskkill).
Unit/fixture tests support this contract but do not establish real inference.
An operator must capture source-bound real entrypoint/model receipts before
claiming the requested skill ran. Review cadence and merge approval are unchanged.

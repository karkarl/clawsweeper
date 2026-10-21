import { DECISION_SCHEMA_KEYS } from "./clawsweeper-policy.js";
import type { SkillModel, SkillExecutionConfig } from "./review-skill-config.js";
import { isRecord } from "./value-coerce.js";

const PHASES = [
  "source",
  "startup",
  "catalog",
  "reviewers",
  "reviewer_output",
  "coordinator",
  "reconciliation",
  "cleanup",
  "result",
  "complete",
] as const;
export type SkillPhase = (typeof PHASES)[number];
const FIELDS = new Set([...DECISION_SCHEMA_KEYS, "json", "envelope", "scope", "adjudications"]);
const ROLES = ["reviewer-0", "reviewer-1", "coordinator"] as const;
const MATCHES = ["matched", "mismatch", "unreported"] as const;
type Match = (typeof MATCHES)[number];
export interface SkillAppliedSummary {
  model: Match;
  reasoningEffort: Match;
  contextTier: Match;
}
export interface SkillSessionDiagnostic {
  role: (typeof ROLES)[number];
  requested: SkillModel;
  before?: SkillAppliedSummary;
  after?: SkillAppliedSummary;
  usage: Match;
  usageReasoningEffort?: Match;
}
export interface SkillRunDiagnostic {
  phase: SkillPhase;
  validationField?: string;
  sessions: SkillSessionDiagnostic[];
  cleanup?: { sessionFailures: number; shutdownFailed: boolean };
}
export function skillAppliedSummary(
  requested: SkillModel,
  actual: { modelId?: string; reasoningEffort?: string; contextTier?: string },
): SkillAppliedSummary {
  const match = (value: string | undefined, expected: string): Match =>
    value === undefined ? "unreported" : value === expected ? "matched" : "mismatch";
  return {
    model: match(actual.modelId, requested.model),
    reasoningEffort: match(actual.reasoningEffort, requested.reasoningEffort),
    contextTier: match(actual.contextTier, requested.contextTier),
  };
}
// Call only while handling a host decision-parser failure, never SDK/provider
// errors. Keep its whitelisted root field, not the rest of its message/value.
export function skillDecisionValidationField(error: unknown): string {
  const field =
    error instanceof Error
      ? /^decision\.([a-zA-Z][a-zA-Z0-9]*)\b/.exec(error.message)?.[1]
      : undefined;
  return field && FIELDS.has(field) ? field : "envelope";
}
export function sanitizeSkillDiagnostic(
  value: unknown,
  config?: SkillExecutionConfig,
): SkillRunDiagnostic {
  const row = isRecord(value) ? value : {};
  const phase = PHASES.find((phase) => phase === row.phase) ?? "result";
  const sessions: SkillSessionDiagnostic[] = [];
  for (const candidate of Array.isArray(row.sessions) ? row.sessions.slice(0, 3) : []) {
    if (!isRecord(candidate) || !config) continue;
    const role = ROLES.find((role) => role === candidate.role);
    const requested =
      role === "coordinator"
        ? config.coordinator
        : role === "reviewer-0"
          ? config.reviewers[0]
          : config.reviewers[1];
    const effort = ["low", "medium", "high", "xhigh", "max"].find(
      (effort) => effort === requested.reasoningEffort,
    ) as SkillModel["reasoningEffort"] | undefined;
    const context = ["default", "long_context"].find(
      (context) => context === requested.contextTier,
    ) as SkillModel["contextTier"] | undefined;
    if (
      !role ||
      !effort ||
      !context ||
      typeof requested.model !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(requested.model)
    )
      continue;
    const summary = (value: unknown): SkillAppliedSummary | undefined => {
      if (!isRecord(value)) return undefined;
      return {
        model: MATCHES.find((match) => match === value.model) ?? "unreported",
        reasoningEffort: MATCHES.find((match) => match === value.reasoningEffort) ?? "unreported",
        contextTier: MATCHES.find((match) => match === value.contextTier) ?? "unreported",
      };
    };
    const before = summary(candidate.before);
    const after = summary(candidate.after);
    sessions.push({
      role,
      requested: { model: requested.model, reasoningEffort: effort, contextTier: context },
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
      usage: MATCHES.find((match) => match === candidate.usage) ?? "unreported",
      usageReasoningEffort:
        MATCHES.find((match) => match === candidate.usageReasoningEffort) ?? "unreported",
    });
  }
  const cleanup =
    isRecord(row.cleanup) &&
    Number.isSafeInteger(row.cleanup.sessionFailures) &&
    Number(row.cleanup.sessionFailures) >= 0 &&
    Number(row.cleanup.sessionFailures) <= 3 &&
    typeof row.cleanup.shutdownFailed === "boolean"
      ? {
          sessionFailures: Number(row.cleanup.sessionFailures),
          shutdownFailed: row.cleanup.shutdownFailed,
        }
      : undefined;
  return {
    phase,
    sessions,
    ...(typeof row.validationField === "string" && FIELDS.has(row.validationField)
      ? { validationField: row.validationField }
      : {}),
    ...(cleanup ? { cleanup } : {}),
  };
}
export class ReviewSkillProcessError extends Error {
  readonly diagnostic: SkillRunDiagnostic;
  constructor(value: unknown, config?: SkillExecutionConfig, options?: ErrorOptions) {
    const diagnostic = sanitizeSkillDiagnostic(value, config);
    super(
      "Review skill incomplete: phase=" +
        diagnostic.phase +
        (diagnostic.validationField ? "; validation=" + diagnostic.validationField : "") +
        "; sessions=" +
        JSON.stringify(diagnostic.sessions) +
        (diagnostic.cleanup ? "; cleanup=" + JSON.stringify(diagnostic.cleanup) : ""),
      options,
    );
    this.name = "ReviewSkillProcessError";
    this.diagnostic = diagnostic;
  }
}

// Fixed host-only identity preserves existing cancellation/retry classification.
export class ReviewSkillAuthorityError extends Error {
  constructor(readonly superseded: boolean) {
    super(
      superseded
        ? "Explicit review skill cancelled: live review authority was superseded."
        : "Explicit review skill incomplete: live review authority unavailable; retry required.",
    );
    this.name = "ReviewSkillAuthorityError";
  }
}

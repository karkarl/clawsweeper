import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sha256 } from "./content-hash.js";
import { isRecord } from "./value-coerce.js";

export interface HanselmanModel {
  model: string;
  reasoningEffort: "high";
  contextTier: "default" | "long_context";
}

export interface HanselmanProvenance {
  status: "complete";
  skillRevision: string;
  headSha: string;
  baseSha: string;
  evidenceDigest: string;
  models: (Omit<HanselmanModel, "contextTier"> & {
    contextTier: HanselmanModel["contextTier"] | "unreported";
    sessionId: string;
    role: string;
  })[];
  scope: string[];
  adjudications: HanselmanAdjudication[];
  reviews: { scope: string; findings: HanselmanFinding[] }[];
}

export interface HanselmanIncompleteProvenance {
  status: "incomplete";
  skillRevision: string;
  headSha: string;
  baseSha: string;
  requestedModels: (HanselmanModel & { role: string })[];
  observedModels: {
    role: string;
    modelId?: string;
    reasoningEffort?: string;
    contextTier?: string;
  }[];
}

export function incompleteHanselmanProvenance(
  headSha: string,
  baseSha: string,
): HanselmanIncompleteProvenance {
  const contract = hanselmanContract();
  return {
    status: "incomplete",
    skillRevision: contract.revision,
    headSha,
    baseSha,
    requestedModels: [
      ...contract.reviewers.map((model, index) => ({
        ...model,
        role: index === 0 ? "opus" : "astra",
      })),
      { ...contract.coordinator, role: "coordinator" },
    ],
    observedModels: [],
  };
}

export interface HanselmanFinding {
  title: string;
  body: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  file: string;
  lineStart: number;
  lineEnd: number;
  suggestedFix: string;
}

export interface HanselmanAdjudication {
  opus: number | null;
  astra: number | null;
  disposition: "accepted" | "rejected";
  disputed: boolean;
  evidence: string;
  suggestedFix: string;
  fixConfidence: number;
  findingConfidence: number;
}

const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 20_000;
const only = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const reference = (value: unknown) =>
  value === null || (Number.isSafeInteger(value) && Number(value) >= 0);

export function isHanselmanFinding(value: unknown): value is HanselmanFinding {
  return (
    isRecord(value) &&
    only(value, ["title", "body", "severity", "file", "lineStart", "lineEnd", "suggestedFix"]) &&
    [value.title, value.body, value.file, value.suggestedFix].every(text) &&
    ["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(
      typeof value.severity === "string" ? value.severity : "",
    ) &&
    Number.isSafeInteger(value.lineStart) &&
    Number(value.lineStart) >= 1 &&
    Number.isSafeInteger(value.lineEnd) &&
    Number(value.lineEnd) >= Number(value.lineStart) &&
    Number(value.lineEnd) - Number(value.lineStart) <= 50
  );
}

export function isHanselmanProvenance(
  value: unknown,
): value is HanselmanProvenance | HanselmanIncompleteProvenance {
  if (
    !isRecord(value) ||
    typeof value.skillRevision !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.skillRevision)
  )
    return false;
  const sha = (field: unknown) => typeof field === "string" && /^[0-9a-f]{40}$/.test(field);
  const role = (field: unknown) => field === "opus" || field === "astra" || field === "coordinator";
  const model = (field: unknown, session: boolean) =>
    isRecord(field) &&
    only(field, [
      "model",
      "reasoningEffort",
      "contextTier",
      "role",
      ...(session ? ["sessionId"] : []),
    ]) &&
    role(field.role) &&
    field.model === (field.role === "opus" ? "claude-opus-5.5" : "gpt-6-astra") &&
    field.reasoningEffort === "high" &&
    (field.role === "opus"
      ? field.contextTier === "default" || (session && field.contextTier === "unreported")
      : field.contextTier === "long_context") &&
    (!session || text(field.sessionId));
  const allRoles = (models: unknown, session: boolean) =>
    Array.isArray(models) &&
    models.length === 3 &&
    models.every((field) => model(field, session)) &&
    new Set(models.map((field) => field.role)).size === 3;
  if (value.status === "incomplete") {
    return (
      only(value, [
        "status",
        "skillRevision",
        "headSha",
        "baseSha",
        "requestedModels",
        "observedModels",
      ]) &&
      (value.headSha === "" || sha(value.headSha)) &&
      (value.baseSha === "" || sha(value.baseSha)) &&
      allRoles(value.requestedModels, false) &&
      Array.isArray(value.observedModels) &&
      value.observedModels.length <= 3 &&
      value.observedModels.every(
        (field) =>
          isRecord(field) &&
          only(field, ["role", "modelId", "reasoningEffort", "contextTier"]) &&
          role(field.role) &&
          [field.modelId, field.reasoningEffort, field.contextTier].every(
            (entry) => entry === undefined || (typeof entry === "string" && entry.length <= 200),
          ),
      )
    );
  }
  if (
    value.status !== "complete" ||
    !only(value, [
      "status",
      "skillRevision",
      "headSha",
      "baseSha",
      "evidenceDigest",
      "models",
      "scope",
      "adjudications",
      "reviews",
    ]) ||
    !sha(value.headSha) ||
    !sha(value.baseSha) ||
    typeof value.evidenceDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.evidenceDigest) ||
    !allRoles(value.models, true) ||
    !Array.isArray(value.scope) ||
    value.scope.length !== 2 ||
    !value.scope.every(text) ||
    !Array.isArray(value.reviews) ||
    value.reviews.length !== 2 ||
    !value.reviews.every(
      (review) =>
        isRecord(review) &&
        only(review, ["scope", "findings"]) &&
        text(review.scope) &&
        Array.isArray(review.findings) &&
        review.findings.length <= 40 &&
        review.findings.every(isHanselmanFinding),
    ) ||
    !Array.isArray(value.adjudications)
  )
    return false;
  const validRows = value.adjudications.every(
    (row) =>
      isRecord(row) &&
      only(row, [
        "opus",
        "astra",
        "disposition",
        "disputed",
        "evidence",
        "suggestedFix",
        "fixConfidence",
        "findingConfidence",
      ]) &&
      reference(row.opus) &&
      reference(row.astra) &&
      (row.opus !== null || row.astra !== null) &&
      (row.disposition === "accepted" || row.disposition === "rejected") &&
      typeof row.disputed === "boolean" &&
      text(row.evidence) &&
      text(row.suggestedFix) &&
      Number.isSafeInteger(row.fixConfidence) &&
      Number(row.fixConfidence) >= 0 &&
      Number(row.fixConfidence) <= 99 &&
      typeof row.findingConfidence === "number" &&
      Number.isFinite(row.findingConfidence) &&
      row.findingConfidence >= 0 &&
      row.findingConfidence <= 1,
  );
  if (!validRows) return false;
  const covered = [new Set<number>(), new Set<number>()];
  for (const row of value.adjudications) {
    for (const [index, key] of ["opus", "astra"].entries()) {
      if (row[key] === null) continue;
      const reference = Number(row[key]);
      if (!value.reviews[index].findings[reference] || covered[index]!.has(reference)) return false;
      covered[index]!.add(reference);
    }
  }
  const scopes = value.scope;
  return value.reviews.every(
    (review, index) =>
      covered[index]!.size === review.findings.length && review.scope === scopes[index],
  );
}

interface Contract {
  version: 1;
  reviewers: [HanselmanModel, HanselmanModel];
  coordinator: HanselmanModel;
  severityPriority: Record<HanselmanFinding["severity"], 0 | 1 | 2 | 3>;
  limits: {
    maxFindingsPerReviewer: number;
    maxReadCallsPerSession: number;
    maxReadBytesPerSession: number;
    maxAiCreditsPerSession: number;
  };
}

export function hanselmanContract() {
  const root = new URL("../.agents/skills/hanselman-code-review/", import.meta.url);
  const text = readFileSync(new URL("SKILL.md", root), "utf8").replace(/\r\n/g, "\n");
  const json = readFileSync(new URL("contract.json", root), "utf8").replace(/\r\n/g, "\n");
  const contract = JSON.parse(json) as Contract;
  if (
    contract.version !== 1 ||
    contract.reviewers.length !== 2 ||
    contract.reviewers[0].model !== "claude-opus-5.5" ||
    contract.reviewers[1].model !== "gpt-6-astra" ||
    contract.reviewers[1].contextTier !== "long_context" ||
    [...contract.reviewers, contract.coordinator].some((model) => model.reasoningEffort !== "high")
  )
    throw new Error("Invalid trusted Hanselman contract.");
  const section = (heading: string): string => {
    const content = text.split(`## ${heading}\n`)[1]?.split("\n## ")[0]?.trim();
    if (!content) throw new Error(`Missing trusted Hanselman instruction section: ${heading}`);
    return content;
  };
  return {
    ...contract,
    revision: sha256(`${json}\n${text}`),
    reviewerInstructions: section("Reviewer instructions"),
    reconciliationInstructions: section("Reconciliation instructions"),
    path: fileURLToPath(root),
  };
}

export function hanselmanPolicyHash(singlePolicy: string): string {
  return sha256(
    JSON.stringify({
      singlePolicy,
      strategy: "hanselman",
      execution: "normal-assessment-then-complementary-v1",
      skillRevision: hanselmanContract().revision,
      transport: "@github/copilot-sdk@1.0.22/pinned-source-v1",
    }),
  ).slice(0, 16);
}

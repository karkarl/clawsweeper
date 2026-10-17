export type ReviewStrategy = "single" | "hanselman";

export const HANSELMAN_TARGET = "openclaw/openclaw-windows-node";

export function effectiveReviewStrategy(
  repo: string,
  kind: string,
  requested: ReviewStrategy = "single",
): ReviewStrategy {
  assertReviewStrategyTarget(requested, repo, kind);
  return repo.toLowerCase() === HANSELMAN_TARGET && kind === "pull_request"
    ? "hanselman"
    : requested;
}

export function reviewStrategy(value: unknown): ReviewStrategy {
  if (value === undefined || value === "" || value === "single") return "single";
  if (value === "hanselman") return value;
  throw new Error("Unsupported review strategy. Expected single or hanselman.");
}

export function assertReviewStrategyTarget(
  strategy: ReviewStrategy,
  repo: string,
  kind: string,
): void {
  if (
    strategy === "hanselman" &&
    (repo.toLowerCase() !== HANSELMAN_TARGET || kind !== "pull_request")
  ) {
    throw new Error("Hanselman review is supported only for openclaw/openclaw-windows-node PRs.");
  }
}

export function hanselmanCommand(commandText: string): boolean {
  return /^review\s+hanselman(?:\s|$)/i.test(commandText.trim());
}

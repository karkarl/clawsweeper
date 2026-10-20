import type { ModelInfo } from "@github/copilot-sdk";
import type { SkillExecutionConfig } from "./review-skill-config.js";
import { requireRecord, isRecord } from "./value-coerce.js";
import { sha256 } from "./content-hash.js";

// Optional OpenAI-compatible BYOK catalog. No hard-coded model capabilities,
// aliases or fallback; unsupported catalog shapes fail incomplete. Models are
// public metadata: credentials are sent only by the SDK to the chosen provider.
export async function readSkillProviderCatalog(
  config: SkillExecutionConfig,
  deadlineAt: number,
): Promise<{ models: ModelInfo[]; digest: string }> {
  if (!config.provider) throw new Error("No BYOK provider selected.");
  const response = await fetch(config.provider.baseUrl + "/models", {
    redirect: "error",
    signal: AbortSignal.timeout(Math.max(1, deadlineAt - Date.now())),
  });
  if (!response.ok || !response.body) throw new Error("Review skill provider catalog unavailable.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 4 * 1024 * 1024)
        throw new Error("Review skill provider catalog byte budget exceeded.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const envelope = requireRecord(JSON.parse(text), "provider catalog");
  if (!Array.isArray(envelope.data)) throw new Error("Review skill unsupported provider catalog.");
  const wanted = new Set([...config.reviewers, config.coordinator].map((model) => model.model));
  const models = envelope.data
    .map((value) => requireRecord(value, "provider model"))
    .filter((value) => wanted.has(String(value.id)))
    .map((row): ModelInfo => {
      const parameters = Array.isArray(row.supported_parameters) ? row.supported_parameters : [];
      const architecture =
        row.architecture && typeof row.architecture === "object"
          ? (row.architecture as Record<string, unknown>)
          : {};
      const top =
        row.top_provider && typeof row.top_provider === "object"
          ? (row.top_provider as Record<string, unknown>)
          : {};
      const context = Number(row.context_length);
      if (
        typeof row.id !== "string" ||
        !Number.isSafeInteger(context) ||
        context <= 0 ||
        !parameters.includes("reasoning_effort") ||
        !parameters.includes("tools") ||
        !parameters.includes("structured_outputs") ||
        !parameters.includes("response_format")
      )
        throw new Error("Review skill catalog lacks requested model capabilities.");
      return {
        id: row.id,
        name: typeof row.name === "string" ? row.name : row.id,
        capabilities: {
          supports: {
            reasoningEffort: true,
            vision:
              Array.isArray(architecture.input_modalities) &&
              architecture.input_modalities.includes("image"),
          },
          limits: {
            max_context_window_tokens: context,
            ...(Number.isSafeInteger(top.max_completion_tokens) &&
            Number(top.max_completion_tokens) > 0
              ? { max_output_tokens: Number(top.max_completion_tokens) }
              : {}),
          },
        },
      };
    });
  if (models.length !== wanted.size)
    throw new Error("Review skill requested provider model unavailable.");
  return { models, digest: sha256(text) };
}

export interface SkillRuntimeProvenance {
  adapter: "copilot";
  sdk: "1.0.22";
  providerKind: "openai-compatible" | "copilot" | "unreported";
  catalogDigest?: string;
}
// Only fixed public metadata crosses into exported receipts. Endpoint/credential
// routing remains in trusted config and the SDK, never this public projection.
export function publicSkillProvenance(value: unknown): SkillRuntimeProvenance | undefined {
  if (!isRecord(value) || value.adapter !== "copilot" || value.sdk !== "1.0.22") return undefined;
  return {
    adapter: "copilot",
    sdk: "1.0.22",
    providerKind:
      value.providerKind === "openai-compatible" || value.providerKind === "copilot"
        ? value.providerKind
        : "unreported",
    ...(typeof value.catalogDigest === "string" && /^[0-9a-f]{64}$/.test(value.catalogDigest)
      ? { catalogDigest: value.catalogDigest }
      : {}),
  };
}
export function skillProviderProvenance(
  config: SkillExecutionConfig,
  catalogDigest?: string,
): SkillRuntimeProvenance {
  return publicSkillProvenance({
    adapter: "copilot",
    sdk: "1.0.22",
    providerKind: config.provider ? "openai-compatible" : "copilot",
    catalogDigest,
  })!;
}

import { buildFallbackReport } from "../audits/fallback-report";
import type { KaseobotAuditResult } from "../audits/types";
import { buildFilteredAuditInput } from "./filtered-audit-input";
import { toTelegramMarkdownV2 } from "./markdown";
import { DEFAULT_KIMI_ENDPOINT, DEFAULT_KIMI_MODEL, DEFAULT_KIMI_TIMEOUT_MS, KimiApiError, NvidiaKimiClient, type KimiClientLike } from "./kimi-client";
import { buildKimiUserPrompt, KASEOBOT_KIMI_SYSTEM_PROMPT } from "./prompts";

export interface KimiEnvironment {
  NVIDIA_API_KEY?: string;
  NVIDIA_KIMI_MODEL?: string;
  NVIDIA_KIMI_ENDPOINT?: string;
  KIMI_TIMEOUT_MS?: string;
  MAX_FINDINGS_FOR_KIMI?: string;
  MAX_EVIDENCE_LENGTH?: string;
}

export interface AiReportMetadata {
  provider: "nvidia";
  model: string;
  used: boolean;
  requestId: string | null;
  error: string | null;
  /** Persisted so a queue redelivery does not make a duplicate model call. */
  reportMarkdownV2: string;
  /** Complete source Markdown for an optional .md attachment. */
  reportMarkdown: string;
}

export interface GeneratedAuditReport {
  markdown: string;
  markdownV2: string;
  ai: AiReportMetadata;
}

export async function generateAuditReport(
  audit: KaseobotAuditResult,
  env: KimiEnvironment,
  client?: KimiClientLike,
): Promise<GeneratedAuditReport> {
  const model = env.NVIDIA_KIMI_MODEL?.trim() || DEFAULT_KIMI_MODEL;
  const fallbackMarkdown = buildFallbackReport(audit);
  const fallback = toTelegramMarkdownV2(fallbackMarkdown);
  if (!env.NVIDIA_API_KEY?.trim()) {
    return {
      markdown: fallbackMarkdown,
      markdownV2: fallback,
      ai: { provider: "nvidia", model, used: false, requestId: null, error: "NVIDIA_API_KEY is not configured; deterministic fallback used.", reportMarkdownV2: fallback, reportMarkdown: fallbackMarkdown },
    };
  }

  const filtered = buildFilteredAuditInput(
    audit,
    parseFindingLimit(env.MAX_FINDINGS_FOR_KIMI),
    parseEvidenceLimit(env.MAX_EVIDENCE_LENGTH),
  );
  const prompts = {
    systemPrompt: KASEOBOT_KIMI_SYSTEM_PROMPT,
    userPrompt: buildKimiUserPrompt(audit, filtered),
  };
  try {
    const kimi = client ?? new NvidiaKimiClient({
      apiKey: env.NVIDIA_API_KEY,
      model,
      endpoint: env.NVIDIA_KIMI_ENDPOINT?.trim() || DEFAULT_KIMI_ENDPOINT,
      timeoutMs: parseTimeout(env.KIMI_TIMEOUT_MS),
    });
    const completion = await kimi.complete(prompts);
    const markdown = completion.markdown.trim();
    const markdownV2 = toTelegramMarkdownV2(markdown);
    if (!markdownV2.trim()) throw new KimiApiError("NVIDIA Kimi returned an empty report.", completion.requestId);
    return {
      markdown,
      markdownV2,
      ai: { provider: "nvidia", model, used: true, requestId: completion.requestId, error: null, reportMarkdownV2: markdownV2, reportMarkdown: markdown },
    };
  } catch (error) {
    const requestId = error instanceof KimiApiError ? error.requestId : null;
    const message = error instanceof KimiApiError ? error.message : "NVIDIA Kimi report generation failed.";
    return {
      markdown: fallbackMarkdown,
      markdownV2: fallback,
      ai: { provider: "nvidia", model, used: false, requestId, error: safeError(message), reportMarkdownV2: fallback, reportMarkdown: fallbackMarkdown },
    };
  }
}

function parseTimeout(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, 60_000)
    : DEFAULT_KIMI_TIMEOUT_MS;
}

function parseFindingLimit(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 25) : 25;
}

function parseEvidenceLimit(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 300) : 300;
}

function safeError(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").slice(0, 300);
}

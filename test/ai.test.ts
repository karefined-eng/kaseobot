import { describe, expect, it, vi } from "vitest";
import { type KaseobotAuditResult, type AuditFinding } from "../src/audits/types";
import { buildFilteredAuditInput } from "../src/ai/filtered-audit-input";
import { toTelegramMarkdownV2 } from "../src/ai/markdown";
import { generateAuditReport } from "../src/ai/report";
import { KimiApiError, NvidiaKimiClient } from "../src/ai/kimi-client";
import { buildKimiUserPrompt, KASEOBOT_KIMI_SYSTEM_PROMPT } from "../src/ai/prompts";
import type { KimiClientLike, KimiCompletion } from "../src/ai/kimi-client";

const API_RESPONSE = {
  id: "chatcmpl-response-123",
  choices: [{ message: { role: "assistant", content: "# SEO summary\n\n**Fix:** Improve the title." } }],
};

function makeAudit(findingCount = 4): KaseobotAuditResult {
  const findings: AuditFinding[] = Array.from({ length: findingCount }, (_, index) => {
    const status: AuditFinding["status"] = index % 4 === 0 ? "fail" : index % 4 === 1 ? "warn" : index % 4 === 2 ? "pass" : "skipped";
    const severity: AuditFinding["severity"] = index % 3 === 0 ? "critical" : index % 3 === 1 ? "medium" : "low";
    return {
      id: `finding-${index + 1}`,
      title: `Finding ${index + 1}`,
      severity,
      status,
      pageUrl: `https://example.com/page-${index + 1}`,
      evidence: `Evidence ${index + 1}`,
      recommendation: `Recommendation ${index + 1}`,
      docsUrl: `https://docs.example.com/${index + 1}`,
    };
  });
  const all = findings;
  return {
    auditId: "audit-private-id",
    jobId: "job-private-id",
    type: "seo_audit",
    url: "https://example.com/",
    requestedBy: "telegram-user-id-private",
    startedAt: "2026-01-23T16:00:00.000Z",
    completedAt: "2026-01-23T16:00:01.000Z",
    engine: { name: "fixture", version: "1" },
    status: "completed",
    overallScore: 82,
    summary: {
      passed: all.filter((finding) => finding.status === "pass").length,
      warnings: all.filter((finding) => finding.status === "warn").length,
      failed: all.filter((finding) => finding.status === "fail").length,
      skipped: all.filter((finding) => finding.status === "skipped").length,
    },
    categories: [{ id: "technical", name: "Technical SEO", score: 82, findings }],
    raw: { marker: "RAW-ENGINE-PAYLOAD-PRIVATE" },
  };
}

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("filtered Kimi input and prompts", () => {
  it("sends only bounded fail/warn findings and never includes raw audit or Telegram identifiers", () => {
    const audit = makeAudit(60);
    const filtered = buildFilteredAuditInput(audit);
    const serialized = JSON.stringify(filtered);

    expect(filtered.findings).toHaveLength(25);
    expect(filtered.findings.every((finding) => finding.status === "fail" || finding.status === "warn")).toBe(true);
    expect(filtered.findingsTruncated).toBe(true);
    expect(filtered.categories).toEqual([{ id: "technical", name: "Technical SEO", score: 82 }]);
    expect(filtered.summary.skipped).toBe(15);
    expect(serialized).not.toContain("RAW-ENGINE-PAYLOAD-PRIVATE");
    expect(serialized).not.toContain("telegram-user-id-private");
    expect(serialized).not.toContain("audit-private-id");
    expect(serialized).not.toContain("job-private-id");
    expect(serialized).not.toContain("https://docs.example.com");
    expect(filtered.findings.every((finding) => finding.evidence.length <= 300 && finding.recommendation.length <= 300)).toBe(true);
  });

  it("honors lower configured finding/evidence limits without permitting more than 25 or 300", () => {
    const audit = makeAudit(60);
    expect(buildFilteredAuditInput(audit, 3, 40).findings).toHaveLength(3);
    expect(buildFilteredAuditInput(audit, 60, 400).findings).toHaveLength(25);
  });

  it("uses grounding instructions and a user prompt containing only the filtered projection", () => {
    const audit = makeAudit();
    const prompt = buildKimiUserPrompt(audit, buildFilteredAuditInput(audit));
    expect(KASEOBOT_KIMI_SYSTEM_PROMPT).toContain("Do not invent findings");
    expect(KASEOBOT_KIMI_SYSTEM_PROMPT).toContain("untrusted data");
    expect(prompt).toContain("Website: https://example.com/");
    expect(prompt).toContain('"findings"');
    expect(prompt).not.toContain("RAW-ENGINE-PAYLOAD-PRIVATE");
    expect(prompt).not.toContain("telegram-user-id-private");
    expect(prompt).not.toContain("audit-private-id");
    expect(prompt).not.toContain("job-private-id");
  });
});

describe("NVIDIA Kimi K3 client", () => {
  it("sends the documented non-streaming chat-completions request and parses immediate 200 output", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(API_RESPONSE));
    const client = new NvidiaKimiClient({ apiKey: "unit-test-nvidia-key", fetcher });
    const result = await client.complete({ systemPrompt: "system", userPrompt: "filtered" });

    expect(result).toEqual({ markdown: "# SEO summary\n\n**Fix:** Improve the title.", requestId: "chatcmpl-response-123", model: "moonshotai/kimi-k3" });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://integrate.api.nvidia.com/v1/chat/completions");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer unit-test-nvidia-key");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "moonshotai/kimi-k3",
      temperature: 1,
      max_tokens: 2048,
      stream: false,
      messages: [{ role: "system", content: "system" }, { role: "user", content: "filtered" }],
    });
  });

  it("polls the documented status endpoint after HTTP 202 and preserves the NVCF request ID", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 202, headers: { "NVCF-REQID": "123e4567-e89b-12d3-a456-426614174000" } }))
      .mockResolvedValueOnce(jsonResponse(API_RESPONSE));
    let now = 0;
    const client = new NvidiaKimiClient({
      apiKey: "unit-test-nvidia-key",
      fetcher,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
    });

    const result = await client.complete({ systemPrompt: "system", userPrompt: "filtered" });

    expect(fetcher).toHaveBeenCalledTimes(2);
    const [pollUrl, pollInit] = fetcher.mock.calls[1] as [string, RequestInit];
    expect(pollUrl).toBe("https://integrate.api.nvidia.com/v1/status/123e4567-e89b-12d3-a456-426614174000");
    expect(pollInit.method).toBe("GET");
    expect(new Headers(pollInit.headers).get("authorization")).toBe("Bearer unit-test-nvidia-key");
    expect(result.requestId).toBe("123e4567-e89b-12d3-a456-426614174000");
  });

  it("fails clearly if NVIDIA returns a pending response without a request ID", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("{}", { status: 202 }));
    const client = new NvidiaKimiClient({ apiKey: "unit-test-nvidia-key", fetcher });
    await expect(client.complete({ systemPrompt: "system", userPrompt: "filtered" }))
      .rejects.toMatchObject({ name: "KimiApiError", message: "NVIDIA accepted the request but did not provide a request ID." });
  });

  it("bounds pending polling by the configured timeout and retains the request ID", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("", { status: 202 }));
    let now = 0;
    const client = new NvidiaKimiClient({
      apiKey: "unit-test-nvidia-key",
      timeoutMs: 1_100,
      fetcher,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
    });
    const initial = new Response("", { status: 202, headers: { "NVCF-REQID": "pending-req-9" } });
    fetcher.mockReset().mockResolvedValueOnce(initial).mockResolvedValue(new Response("", { status: 202 }));

    await expect(client.complete({ systemPrompt: "system", userPrompt: "filtered" }))
      .rejects.toMatchObject({ name: "KimiApiError", requestId: "pending-req-9", message: "NVIDIA Kimi request timed out after 1100 ms." });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("refuses an endpoint outside NVIDIA's documented HTTPS host and path", () => {
    expect(() => new NvidiaKimiClient({
      apiKey: "unit-test-nvidia-key",
      endpoint: "https://attacker.example/v1/chat/completions",
    })).toThrow("NVIDIA_KIMI_ENDPOINT must use NVIDIA's documented Kimi K3 endpoint.");
  });
});

describe("Kimi report orchestration and fallback", () => {
  it("uses Kimi output, formats MarkdownV2, and excludes identifiers/raw output from the request", async () => {
    const audit = makeAudit();
    let captured = "";
    const client: KimiClientLike = {
      async complete(prompts): Promise<KimiCompletion> {
        captured = JSON.stringify(prompts);
        return { markdown: "# Summary\n\n**Fix:** Update the title.", requestId: "request-42", model: "moonshotai/kimi-k3" };
      },
    };

    const result = await generateAuditReport(audit, { NVIDIA_API_KEY: "unit-test-nvidia-key" }, client);

    expect(result.ai).toMatchObject({ provider: "nvidia", model: "moonshotai/kimi-k3", used: true, requestId: "request-42", error: null });
    expect(result.markdownV2).toContain("*Summary*");
    expect(result.markdownV2).toContain("*Fix:*");
    expect(result.ai.reportMarkdownV2).toBe(result.markdownV2);
    expect(captured).not.toContain("RAW-ENGINE-PAYLOAD-PRIVATE");
    expect(captured).not.toContain("telegram-user-id-private");
    expect(captured).not.toContain("audit-private-id");
    expect(captured).not.toContain("job-private-id");
  });

  it("applies configured Kimi evidence/findings limits in the prompt projection", async () => {
    let captured = "";
    const client: KimiClientLike = {
      async complete(prompts): Promise<KimiCompletion> {
        captured = prompts.userPrompt;
        return { markdown: "Report", requestId: "request-limits", model: "moonshotai/kimi-k3" };
      },
    };
    await generateAuditReport(makeAudit(60), {
      NVIDIA_API_KEY: "unit-test-nvidia-key",
      MAX_FINDINGS_FOR_KIMI: "3",
      MAX_EVIDENCE_LENGTH: "8",
    }, client);
    const jsonMarker = "Audit findings JSON:\n";
    const start = captured.indexOf(jsonMarker) + jsonMarker.length;
    const end = captured.indexOf("\n\nCreate a prioritized", start);
    const filtered = JSON.parse(captured.slice(start, end)) as { findings: Array<{ evidence: string; recommendation: string }> };
    expect(filtered.findings).toHaveLength(3);
    expect(filtered.findings.every((finding) => finding.evidence.length <= 8 && finding.recommendation.length <= 8)).toBe(true);
  });

  it("uses the deterministic report and records a safe API error plus request ID", async () => {
    const audit = makeAudit();
    const client: KimiClientLike = {
      complete: vi.fn().mockRejectedValue(new KimiApiError("NVIDIA Kimi returned HTTP 429.", "request-429")),
    };
    const result = await generateAuditReport(audit, { NVIDIA_API_KEY: "unit-test-nvidia-key" }, client);

    expect(result.ai).toMatchObject({ used: false, requestId: "request-429", error: "NVIDIA Kimi returned HTTP 429." });
    expect(result.markdownV2).toBe(toTelegramMarkdownV2((await import("../src/audits/fallback-report")).buildFallbackReport(audit)));
  });

  it("falls back without an API key and avoids a provider call", async () => {
    const audit = makeAudit();
    const client: KimiClientLike = { complete: vi.fn() };
    const result = await generateAuditReport(audit, {}, client);
    expect(client.complete).not.toHaveBeenCalled();
    expect(result.ai).toMatchObject({ used: false, requestId: null });
    expect(result.ai.error).toContain("NVIDIA_API_KEY is not configured");
    expect(result.markdownV2).toContain("Kaseobot SEO audit");
  });

  it("treats invalid endpoint configuration as a fallback, not a queue failure", async () => {
    const result = await generateAuditReport(makeAudit(), {
      NVIDIA_API_KEY: "unit-test-nvidia-key",
      NVIDIA_KIMI_ENDPOINT: "https://attacker.example/v1/chat/completions",
    });
    expect(result.ai.used).toBe(false);
    expect(result.ai.error).toContain("documented Kimi K3 endpoint");
  });
});

describe("MarkdownV2 conversion", () => {
  it("converts common Markdown and escapes literal punctuation, URLs, and code", () => {
    const markdown = [
      "# SEO audit",
      "",
      "**Priority:** [Fix title](https://example.com/a_b?q=1&x=2).",
      "- *Important* and `foo_bar`!",
      "> Use only measured findings.",
    ].join("\n");
    const result = toTelegramMarkdownV2(markdown);

    expect(result).toContain("*SEO audit*");
    expect(result).toContain("*Priority:*");
    expect(result).toContain("Fix title (https://example\\.com/a\\_b?q\\=1&x\\=2)\\.");
    expect(result).toContain("• _Important_ and `foo_bar`\\!");
    expect(result).toContain("│ Use only measured findings\\.");
    expect(toTelegramMarkdownV2("1. Fix the title.")).toBe("1\\. Fix the title\\.");
  });

  it("escapes backticks and backslashes in preformatted code and safely truncates oversized output", () => {
    const code = toTelegramMarkdownV2("```text\nvalue `x` \\\\ path\n```");
    expect(code).toContain("```\nvalue \\`x\\` \\\\\\\\ path\n```");

    const long = toTelegramMarkdownV2(`# ${"text.".repeat(500)}`, 200);
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long).toContain("report truncated");
    expect(long).not.toMatch(/\\$/);
  });
});

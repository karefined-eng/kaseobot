import { AuditEngineError, type AuditEngine, type AuditPageInput, type RawAuditResult } from "./types";

type AuditCall = (input: Record<string, unknown>) => Promise<unknown>;
type SeoModule = Record<string, unknown> & {
  audit?: AuditCall;
  runAudit?: AuditCall;
  execute?: (args: string[]) => Promise<unknown>;
  createAuditor?: (options: Record<string, unknown>) => { audit?: (url: string) => Promise<unknown> };
  Auditor?: new (options: Record<string, unknown>) => { audit?: (url: string) => Promise<unknown> };
};

/**
 * Optional adapter for a Worker-compatible SEOmator-compatible module.
 * `loadModule` is injected so the Node/browser-heavy npm package is never
 * statically bundled into Kaseobot's Worker. The current factory intentionally
 * selects StaticHtmlAuditEngine after the v5.1.0 Worker bundle probe failed.
 */
export class SeomatorAuditEngine implements AuditEngine {
  constructor(private readonly loadModule: () => Promise<unknown>) {}

  async auditPage(input: AuditPageInput): Promise<RawAuditResult> {
    let loaded: unknown;
    try {
      loaded = await this.loadModule();
    } catch {
      throw new AuditEngineError("The SEOmator package is unavailable in this Worker runtime.", false);
    }
    if (!isRecord(loaded)) throw new AuditEngineError("SEOmator returned an invalid module.", false);

    const module = loaded as SeoModule;
    const options = {
      url: input.url,
      format: "json",
      noCwv: true,
      timeout: input.timeoutMs,
      save: false,
      measureCwv: false,
      includeJavaScriptRendering: false,
    };
    let output: unknown;

    try {
      if (typeof module.audit === "function") {
        output = await module.audit(options);
      } else if (typeof module.runAudit === "function") {
        output = await module.runAudit(options);
      } else if (typeof module.execute === "function") {
        output = await module.execute([
          "audit", input.url, "--format", "json", "--no-cwv", "--timeout", String(input.timeoutMs), "--no-save",
        ]);
      } else {
        const create = module.createAuditor
          ?? (typeof module.Auditor === "function" ? (value: Record<string, unknown>) => new module.Auditor!(value) : undefined);
        const auditor = create?.({ categories: ["core", "technical", "content", "links", "images", "security", "mobile"], measureCwv: false });
        if (!auditor || typeof auditor.audit !== "function") {
          throw new AuditEngineError("The SEOmator module has no supported audit API.", false);
        }
        output = await auditor.audit(input.url);
      }
    } catch (error) {
      if (error instanceof AuditEngineError) throw error;
      throw new AuditEngineError(
        error instanceof Error ? `SEOmator audit failed: ${error.message}` : "SEOmator audit failed.",
        isRetryableError(error),
      );
    }

    const version = typeof module.version === "string" ? module.version : "unknown";
    return { engineName: "seomator", engineVersion: version, output };
  }
}

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  return error.name === "AbortError" || error.name === "TimeoutError" || /network|timeout|temporar|fetch/i.test(error.message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

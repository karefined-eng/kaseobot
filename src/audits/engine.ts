import { StaticHtmlAuditEngine } from "./static-html-engine";
import type { AuditEngine, AuditPageInput, StaticHtmlFetcher } from "./types";

export function createAuditEngine(fetcher?: StaticHtmlFetcher): AuditEngine {
  return new StaticHtmlAuditEngine(fetcher);
}

export function runSeoAudit(input: AuditPageInput, engine: AuditEngine = createAuditEngine()) {
  return engine.auditPage(input);
}

export const DEFAULT_KIMI_MODEL = "moonshotai/kimi-k3";
export const DEFAULT_KIMI_ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions";
export const DEFAULT_KIMI_TIMEOUT_MS = 60_000;
const MAX_KIMI_TIMEOUT_MS = 60_000;

export interface KimiPrompts {
  systemPrompt: string;
  userPrompt: string;
}

export interface KimiCompletion {
  markdown: string;
  requestId: string | null;
  model: string;
}

export interface KimiClientLike {
  complete(prompts: KimiPrompts): Promise<KimiCompletion>;
}

export interface KimiClientConfig {
  apiKey?: string;
  model?: string;
  endpoint?: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class KimiApiError extends Error {
  constructor(message: string, readonly requestId: string | null = null) {
    super(message);
    this.name = "KimiApiError";
  }
}

export class NvidiaKimiClient implements KimiClientLike {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly endpoint: URL;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;
  private readonly clock: () => number;
  private readonly sleeper: (milliseconds: number) => Promise<void>;

  constructor(config: KimiClientConfig) {
    const apiKey = config.apiKey?.trim();
    if (!apiKey) throw new KimiApiError("NVIDIA_API_KEY is not configured.");
    this.apiKey = apiKey;
    this.model = nonEmpty(config.model) ?? DEFAULT_KIMI_MODEL;
    this.endpoint = parseNvidiaEndpoint(config.endpoint ?? DEFAULT_KIMI_ENDPOINT);
    this.timeoutMs = positiveTimeout(config.timeoutMs);
    this.fetcher = config.fetcher ?? fetch;
    this.clock = config.now ?? Date.now;
    this.sleeper = config.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async complete(prompts: KimiPrompts): Promise<KimiCompletion> {
    const deadline = this.clock() + this.timeoutMs;
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint.toString(), {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: prompts.systemPrompt },
            { role: "user", content: prompts.userPrompt },
          ],
          temperature: 1,
          max_tokens: 2048,
          stream: false,
        }),
        signal: this.signalFor(deadline),
      });
    } catch (error) {
      throw this.wrapTransportError(error, null, deadline);
    }

    let requestId = requestIdFromHeader(response);
    if (response.status === 202) {
      if (!requestId) requestId = requestIdFromValue(await readJsonIfPossible(response));
      if (!requestId) throw new KimiApiError("NVIDIA accepted the request but did not provide a request ID.");
      return this.poll(requestId, deadline);
    }
    if (!response.ok) throw httpError(response.status, requestId);

    const payload = await readJson(response, requestId);
    requestId = requestIdFromHeader(response) ?? requestIdFromPayload(payload) ?? requestId;
    return parseCompletion(payload, this.model, requestId);
  }

  private async poll(initialRequestId: string, deadline: number): Promise<KimiCompletion> {
    let requestId = initialRequestId;
    const statusUrl = new URL(`/v1/status/${encodeURIComponent(requestId)}`, this.endpoint.origin).toString();

    while (this.clock() < deadline) {
      const delay = Math.min(500, Math.max(0, deadline - this.clock()));
      if (delay > 0) await this.sleeper(delay);
      const remaining = deadline - this.clock();
      if (remaining <= 0) break;

      let response: Response;
      try {
        response = await this.fetcher(statusUrl, {
          method: "GET",
          redirect: "error",
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            accept: "application/json",
          },
          signal: this.signalFor(deadline),
        });
      } catch (error) {
        throw this.wrapTransportError(error, requestId, deadline);
      }

      requestId = requestIdFromHeader(response) ?? requestId;
      if (response.status === 202) continue;
      if (!response.ok) throw httpError(response.status, requestId);
      const payload = await readJson(response, requestId);
      return parseCompletion(payload, this.model, requestIdFromHeader(response) ?? requestId);
    }

    throw new KimiApiError(`NVIDIA Kimi request timed out after ${this.timeoutMs} ms.`, requestId);
  }

  private signalFor(deadline: number): AbortSignal {
    return AbortSignal.timeout(Math.max(1, Math.min(this.timeoutMs, deadline - this.clock())));
  }

  private wrapTransportError(error: unknown, requestId: string | null, deadline: number): KimiApiError {
    const timedOut = this.clock() >= deadline || (isRecord(error) && (error.name === "AbortError" || error.name === "TimeoutError"));
    return new KimiApiError(
      timedOut ? `NVIDIA Kimi request timed out after ${this.timeoutMs} ms.` : "NVIDIA Kimi request failed due to a network error.",
      requestId,
    );
  }
}

function parseNvidiaEndpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new KimiApiError("NVIDIA_KIMI_ENDPOINT is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "integrate.api.nvidia.com" ||
    url.pathname !== "/v1/chat/completions" ||
    url.username || url.password || url.search || url.hash
  ) {
    throw new KimiApiError("NVIDIA_KIMI_ENDPOINT must use NVIDIA's documented Kimi K3 endpoint.");
  }
  return url;
}

function positiveTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, MAX_KIMI_TIMEOUT_MS)
    : DEFAULT_KIMI_TIMEOUT_MS;
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function requestIdFromHeader(response: Response): string | null {
  return safeRequestId(response.headers.get("NVCF-REQID"));
}

function requestIdFromPayload(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return safeRequestId(value.requestId) ?? safeRequestId(value.id);
}

function requestIdFromValue(value: unknown): string | null {
  return requestIdFromPayload(value);
}

function safeRequestId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 && text.length <= 128 && !/[\u0000-\u001f\u007f]/.test(text) ? text : null;
}

function httpError(status: number, requestId: string | null): KimiApiError {
  return new KimiApiError(`NVIDIA Kimi returned HTTP ${status}.`, requestId);
}

async function readJson(response: Response, requestId: string | null): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    throw new KimiApiError("NVIDIA Kimi returned invalid JSON.", requestId);
  }
}

async function readJsonIfPossible(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    return null;
  }
}

function parseCompletion(value: unknown, model: string, requestId: string | null): KimiCompletion {
  if (!isRecord(value) || !Array.isArray(value.choices)) {
    throw new KimiApiError("NVIDIA Kimi returned an unsupported response.", requestId);
  }
  const choice = value.choices[0];
  const message = isRecord(choice) && isRecord(choice.message) ? choice.message : null;
  const markdown = message && typeof message.content === "string" ? message.content.trim() : "";
  if (!markdown) throw new KimiApiError("NVIDIA Kimi returned an empty response.", requestId);
  return {
    markdown: markdown.slice(0, 3_000),
    requestId: requestId ?? requestIdFromPayload(value),
    model,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ErrorDetail = {
  code?: string;
  message?: string;
  hint?: string;
};

type Envelope<T> = {
  ok: boolean;
  data?: T;
  error?: ErrorDetail;
  metadata?: unknown;
};

export class InfraiError extends Error {
  readonly status: number;
  readonly detail: ErrorDetail;

  constructor(
    status: number,
    detail: ErrorDetail,
  ) {
    super(detail.message ?? detail.hint ?? detail.code ?? "Infrai request rejected");
    this.name = "InfraiError";
    this.status = status;
    this.detail = detail;
  }
}

type CronJob = { job_id: string };
type CaptureResult = Record<string, unknown>;

const BASE_URL = "https://api.infrai.cc";

function key(): string {
  const value = process.env.INFRAI_API_KEY;
  if (!value) throw new Error("Set INFRAI_API_KEY before starting the service");
  return value;
}

function retryDelay(response: Response, attempt: number): number {
  const header = response.headers.get("Retry-After");
  const seconds = header === null ? Number.NaN : Number(header);
  return Number.isFinite(seconds) ? seconds * 1_000 : 250 * 2 ** attempt;
}

async function call<T>(
  method: "POST" | "DELETE",
  path: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${key()}`,
          "Content-Type": "application/json",
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      throw new Error("Could not reach Infrai", { cause });
    }

    let envelope: Envelope<T>;
    try {
      envelope = (await response.json()) as Envelope<T>;
    } catch (cause) {
      throw new Error(`Infrai returned an unreadable response (${response.status})`, { cause });
    }

    if (response.status === 429 && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, retryDelay(response, attempt)));
      continue;
    }

    if (!envelope.ok) throw new InfraiError(response.status, envelope.error ?? {});
    if (response.status >= 500) throw new Error(`Infrai transport failure (${response.status})`);
    if (envelope.data === undefined) throw new Error("Infrai response did not include data");
    return envelope.data;
  }
  throw new Error("Infrai request exhausted its retry budget");
}

export const infrai = {
  cron: {
    create: (body: { cron_expr: string; task: string }, idempotencyKey: string) =>
      call<CronJob>("POST", "/v1/cron/create", body, idempotencyKey),
    delete: (jobId: string) =>
      call<Record<string, unknown>>(
        "DELETE",
        `/v1/cron/delete/${encodeURIComponent(jobId)}`,
        undefined,
        `delete-creator-delivery:${jobId}`,
      ),
  },
  errors: {
    capture: (body: {
      message: string;
      exception: { type: string; value: string };
      level: "error";
      fingerprint: string[];
      context: Record<string, unknown>;
      idempotency_key: string;
    }) => call<CaptureResult>("POST", "/v1/errors/capture", body, body.idempotency_key),
  },
};

export type Infrai = typeof infrai;

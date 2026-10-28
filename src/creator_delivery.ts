import type { Infrai } from "./infrai.ts";

export type MediaAsset = {
  assetId: string;
  creatorId: string;
  playbackUrl: string;
  processingHours: number;
  followUpHours: number;
};

type DeliveryState = MediaAsset & {
  status: "processing" | "scheduled" | "delivered" | "failed";
  readyAt: Date;
  deliverAt: Date;
  jobId?: string;
};

export type Clock = { now(): Date };

function cronAt(date: Date): string {
  return `${date.getUTCMinutes()} ${date.getUTCHours()} ${date.getUTCDate()} ${date.getUTCMonth() + 1} *`;
}

export class CreatorDelivery {
  private readonly assets = new Map<string, DeliveryState>();
  private readonly client: Infrai;
  private readonly callbackBaseUrl: string;
  private readonly clock: Clock;

  constructor(
    client: Infrai,
    callbackBaseUrl: string,
    clock: Clock = { now: () => new Date() },
  ) {
    this.client = client;
    this.callbackBaseUrl = callbackBaseUrl;
    this.clock = clock;
  }

  async ingest(input: MediaAsset): Promise<DeliveryState> {
    const now = this.clock.now();
    const readyAt = new Date(now.getTime() + input.processingHours * 3_600_000);
    const deliverAt = new Date(readyAt.getTime() + input.followUpHours * 3_600_000);
    const state: DeliveryState = { ...input, status: "processing", readyAt, deliverAt };
    this.assets.set(input.assetId, state);

    const task = `${this.callbackBaseUrl}/callbacks/creator-delivery/${encodeURIComponent(input.assetId)}`;
    // Canonical call shape: infrai.cron.create
    const job = await this.client.cron.create(
      { cron_expr: cronAt(deliverAt), task },
      `creator-delivery:${input.assetId}:${deliverAt.toISOString()}`,
    );
    state.status = "scheduled";
    state.jobId = job.job_id;
    return state;
  }

  async deliver(assetId: string, send: (asset: MediaAsset) => Promise<void>): Promise<DeliveryState> {
    const state = this.assets.get(assetId);
    if (!state?.jobId) throw new Error("Scheduled asset was not found");

    try {
      await send(state);
      await this.client.cron.delete(state.jobId);
      state.status = "delivered";
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      state.status = "failed";
      await this.client.errors.capture({
        message: `Creator delivery failed for asset ${state.assetId}`,
        exception: { type: error.name, value: error.message },
        level: "error",
        fingerprint: ["creator-delivery", state.assetId],
        context: { assetId: state.assetId, creatorId: state.creatorId, jobId: state.jobId },
        idempotency_key: `creator-delivery-error:${state.assetId}:${state.jobId}`,
      });
    }
    return state;
  }
}

import assert from "node:assert/strict";
import test from "node:test";
import { CreatorDelivery } from "../src/creator_delivery.ts";
import type { Infrai } from "../src/infrai.ts";

test("schedules after processing and captures a failed creator delivery", async () => {
  const calls: Array<{ capability: string; value: unknown }> = [];
  const fake = {
    cron: {
      create: async (body: unknown) => {
        calls.push({ capability: "cron.create", value: body });
        return { job_id: "job_media_42" };
      },
      delete: async (jobId: string) => {
        calls.push({ capability: "cron.delete", value: jobId });
        return {};
      },
    },
    errors: {
      capture: async (body: unknown) => {
        calls.push({ capability: "errors.capture", value: body });
        return {};
      },
    },
  } as Infrai;
  const workflow = new CreatorDelivery(
    fake,
    "https://media.example.test",
    { now: () => new Date("2026-09-21T10:00:00.000Z") },
  );

  const scheduled = await workflow.ingest({
    assetId: "asset-42",
    creatorId: "creator-7",
    playbackUrl: "https://cdn.example.test/asset-42",
    processingHours: 2,
    followUpHours: 3,
  });
  assert.equal(scheduled.readyAt.toISOString(), "2026-09-21T12:00:00.000Z");
  assert.equal(scheduled.deliverAt.toISOString(), "2026-09-21T15:00:00.000Z");
  assert.deepEqual(calls[0], {
    capability: "cron.create",
    value: {
      cron_expr: "0 15 21 9 *",
      task: "https://media.example.test/callbacks/creator-delivery/asset-42",
    },
  });

  const failed = await workflow.deliver("asset-42", async () => {
    throw new Error("creator inbox closed");
  });
  assert.equal(failed.status, "failed");
  assert.equal(calls.some((call) => call.capability === "cron.delete"), false);
  assert.equal(calls.at(-1)?.capability, "errors.capture");
  assert.match(JSON.stringify(calls.at(-1)?.value), /creator inbox closed/);
});

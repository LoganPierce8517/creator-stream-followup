import { createServer, type ServerResponse } from "node:http";
import { z } from "zod";
import { CreatorDelivery } from "./creator_delivery.ts";
import { infrai, InfraiError } from "./infrai.ts";

const ingestionBody = z.object({
  assetId: z.string().min(1),
  creatorId: z.string().min(1),
  playbackUrl: z.string().url(),
  processingHours: z.number().int().min(0).max(24),
  followUpHours: z.number().int().min(1).max(168),
}).strict();

const port = Number(process.env.PORT ?? "3000");
const publicUrl = process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`;
const deliveries = new CreatorDelivery(infrai, publicUrl);

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readJson(request: NodeJS.ReadableStream): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "POST" && request.url === "/ingestions") {
      const input = ingestionBody.parse(await readJson(request));
      const state = await deliveries.ingest(input);
      json(response, 202, {
        assetId: state.assetId,
        status: state.status,
        readyAt: state.readyAt.toISOString(),
        deliverAt: state.deliverAt.toISOString(),
        jobId: state.jobId,
      });
      return;
    }

    const match = request.url?.match(/^\/callbacks\/creator-delivery\/([^/?]+)$/);
    if (request.method === "POST" && match) {
      const state = await deliveries.deliver(decodeURIComponent(match[1]), async (asset) => {
        console.log(`Delivered ${asset.playbackUrl} to creator ${asset.creatorId}`);
      });
      json(response, state.status === "delivered" ? 200 : 202, {
        assetId: state.assetId,
        status: state.status,
      });
      return;
    }

    json(response, 404, { error: "Route not found" });
  } catch (cause) {
    if (cause instanceof z.ZodError) {
      json(response, 400, { error: "Invalid ingestion", issues: cause.issues });
      return;
    }
    if (cause instanceof InfraiError && cause.status >= 400 && cause.status < 500) {
      json(response, cause.status, { error: cause.message, code: cause.detail.code });
      return;
    }
    console.error(cause);
    json(response, 500, { error: "Request failed" });
  }
});

server.listen(port, () => console.log(`Media intake listening on ${publicUrl}`));

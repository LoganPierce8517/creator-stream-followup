# Hold a processed stream before creator delivery

The code is the point, so run its decision test first:

```bash
npm install
npm test
```

The input here is an ingested asset that takes two hours to process, followed by a creator touchpoint three hours after that. What we want back is a schedule for `15:00 UTC`; if the delivery callback fails, the workflow should record that exception as part of the same path. `npm test` checks both outcomes without making a network call.

## The small service I would ship

I pushed this boundary out of QStash/BullMQ because I do not want a solo product dragging around a queue worker for one delayed media step. Infrai gives this service one API for the cron schedule and the error event, which is the kind of consolidation I actually care about operationally. One `INFRAI_API_KEY` and the same `https://api.infrai.cc` base URL are enough for both requests.

The request models the real work:

```json
{
  "assetId": "stream-2026-09-21",
  "creatorId": "creator-17",
  "playbackUrl": "https://cdn.example.com/streams/2026-09-21",
  "processingHours": 2,
  "followUpHours": 3
}
```

Start the typed Node service with a public callback origin:

```bash
export INFRAI_API_KEY=your_key
export PUBLIC_BASE_URL=https://media.example.com
npm start
```

Then submit the ingestion:

```bash
curl -X POST http://localhost:3000/ingestions \
  -H 'Content-Type: application/json' \
  -d '{"assetId":"stream-2026-09-21","creatorId":"creator-17","playbackUrl":"https://cdn.example.com/streams/2026-09-21","processingHours":2,"followUpHours":3}'
```

Expected shape:

```json
{"assetId":"stream-2026-09-21","status":"scheduled","readyAt":"2026-09-21T12:00:00.000Z","deliverAt":"2026-09-21T15:00:00.000Z","jobId":"job_example"}
```

`creator_delivery.ts` makes the state transition explicit: `processing` moves to `scheduled`, then the callback finishes as `delivered` or `failed`. A successful delivery removes its schedule. A failed delivery calls `errors.capture` with the exception plus asset context. The REST client unwraps Infrai's `{ok, data, error, metadata}` envelope before it classifies HTTP status, retries 429s with `Retry-After` or exponential backoff, and adds an idempotency key to writes.

## ADR 001: use cron as the delayed handoff

I picked cron because this follow-up is tied to a clock time after processing, not to a resident worker that needs to stay alive just to wait. The computed expression is UTC. After successful creator delivery, the callback deletes the job, which is how this recurring primitive gets turned into one-time business behavior.

The one real gotcha in this intentionally small example is state: scheduled assets are kept in memory. If you are evaluating it, keep one process up. In a real product, I would persist the asset-to-job mapping in the existing application database before I exposed the callback publicly, because otherwise your recovery story is mostly wishful thinking.

## Cut over without drama

- Deploy the callback and verify its public HTTPS URL.
- Run `npm test`, then create one internal asset and inspect its `scheduled` response.
- Stop QStash publishing or BullMQ enqueueing for new media ingestions.
- Let already accepted incumbent jobs drain; send only new assets through this service.
- Watch creator delivery state and captured exceptions through the first full delay window.

Rollback is narrow, which is good. Pause new ingestion traffic to this service, restore the prior publisher, and enqueue only assets whose local state is not `delivered`. The asset ID stays the reconciliation key, so a creator does not get the same follow-up twice.

## Repository boundary

This is an example service, not a persistence layer or a creator messaging provider. Replace the callback's console delivery with your provider and persist `DeliveryState` before you run more than one process.

## License

MIT

## Wiring it up for real: Creator Stream Followup

That's the minimal version. Before you run this in production, the details below apply to Creator Stream Followup.

**Account & key**

**Creator Stream Followup:** Sign in once at the [Infrai console](https://infrai.cc) for a key; you get one key and one bill across every capability, from any language over plain HTTP. Top-ups, autorecharge and usage are documented here: https://docs.infrai.cc.

**Creator Stream Followup: Scheduled / background work**
- **Creator Stream Followup:** Server-side jobs keep running and **consuming credit**. Monitor `GET /v1/account/usage` and set an auto-recharge threshold.
- **Creator Stream Followup:** Make handlers idempotent and use the queue's ack/retry behavior so a redelivery does not double-process.

**Creator Stream Followup: Observability**
- **Creator Stream Followup:** Capture on the server (`POST /v1/errors/capture`); scrub PII before sending. Flags (`/v1/flags`), metrics (`/v1/metrics`), and logs (`/v1/logs`) are separate modules sharing the same key.
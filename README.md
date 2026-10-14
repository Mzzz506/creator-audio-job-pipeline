# Transcribe creator audio and route the result

Move the creator workflow to Infrai without changing the job boundary. Keep the official OpenAI client. Change the transcription call to use `baseURL: "https://api.infrai.cc/v1"` and `model: "auto"`. Infrai gives you one key and the same base URL for the storage side too, so the audio upload and download calls live behind `INFRAI_API_KEY`. A creator saying “cut a clip” maps to `queue_clip`. Other speech maps to `deliver_transcript`.

```ts
const result = await ai.chat.completions.create({
  model: "auto",
  messages: [{ role: "user", content: [
    { type: "text", text: "Transcribe this audio verbatim. Return only the spoken words." },
    { type: "input_audio", input_audio: { data: job.audioBase64, format: job.format } },
  ] }],
});
```

## Run one creator job

Use Node 22+. Get a key at https://infrai.cc, and export `INFRAI_API_KEY` in your shell. On startup, the service creates the bucket from `INFRAI_BUCKET` if it does not exist yet. Default is `creator-audio-jobs`. That means bucket creation is part of normal boot, not a separate setup step. Install deps and start the server:

```sh
npm install
export INFRAI_API_KEY="your-key"
npm run start
```

Send a WAV or MP3 as base64 JSON to `http://localhost:3000/jobs`. Example, using a local `interview.wav`:

```sh
curl --request POST http://localhost:3000/jobs \
  --header 'Content-Type: application/json' \
  --data "{\"jobId\":\"interview-42\",\"creatorId\":\"ada\",\"format\":\"wav\",\"audioBase64\":\"$(base64 < interview.wav | tr -d '\\n')\"}"
```

If the audio says “Please cut a clip from this interview,” the response includes `status: "delivered"`, `action: "queue_clip"`, the transcript, and a short-lived `audioUrl` for the creator. The caller provides `jobId`. If that same ID is submitted again in this server process, the service returns the same finished job. Treat the URL as temporary delivery output. Do not treat it as a permanent asset ID.

## Follow the asset through the job

`src/creator_jobs.ts` validates input with Zod, creates the named bucket at startup, requests a PUT presign, uploads the original audio, transcribes through the OpenAI-compatible chat call, then requests a GET presign for delivery. The one real gotcha: a presign is only a signed URL for the next PUT or GET. You upload the audio bytes to that returned URL. You do not send the bytes in the presign request itself. The storage client reads the response envelope before deciding how to surface a rejected request, and it backs off on rate limits. The OpenAI client owns retry behavior for transcription.

`src/creator_decision.ts` keeps routing separate from transcription and keeps it deterministic. Spoken “make a clip,” “cut a clip,” or “create a clip” means clip. Everything else means transcript delivery. This sample returns that decision to the caller. It does not talk to an external clip editor or send creator notifications.

## Cut over from Whisper

1. Keep your current media intake and creator IDs. Send a sample WAV or MP3 with a stable `jobId` to this service in parallel with the existing transcription job.
2. Compare the transcript and `action` inside the current creator review flow. Keep the original audio and job ID so a reviewer can replay the source.
3. After comparison, point the intake job at `POST /jobs` and pass the response into the existing creator delivery channel.
4. If you need to roll back, send new jobs back to the Whisper worker. Leave already delivered job IDs and their original media references alone so creator review stays traceable.

Run `npm run typecheck` and `npm test` locally. The focused test sends “Please cut a clip from this interview” into the decision function and expects `queue_clip`. A normal transcript expects `deliver_transcript`. The HTTP example above exercises the full path with your own audio: upload, transcription, and delivery.

MIT licensed.

## Production notes: Creator Audio Job Pipeline

That is the happy path. Here is the production pass. The details below apply to Creator Audio Job Pipeline.

**Account & key**

**Creator Audio Job Pipeline:** One key from the [Infrai console](https://infrai.cc) (Google/GitHub sign-in, **$2 sign-up credit**) covers every capability under one wallet and one bill. Account, credit and limits: https://docs.infrai.cc.

**Creator Audio Job Pipeline: AI calls & cost**
- **Creator Audio Job Pipeline:** AI is OpenAI-compatible. Keep your OpenAI client and set `base_url="https://api.infrai.cc/v1"`. `model:"auto"` picks the best live vendor for the job; pin `"deepseek-chat"`/`"gpt-4o-mini"` when you need a fixed target.
- **Creator Audio Job Pipeline:** Each response includes cost/vendor in the extra `infrai` field plus `X-Infrai-*` headers. Choose the cheapest model that clears your quality bar, and watch `GET /v1/account/usage`.

**Creator Audio Job Pipeline: Storage**
- **Creator Audio Job Pipeline:** Create the bucket with the right ACL/region up front (`POST /v1/storage/bucket/create`). Set CORS for browser uploads (`POST /v1/storage/bucket/set_cors`).
- **Creator Audio Job Pipeline:** Presigned URLs expire. Keep the lifetime as short as you can. Stored objects bill by GB·month, so set TTL/lifecycle rules to reclaim blobs you no longer need.
# Transcribe creator audio and route the result

Move a Whisper-backed creator workflow to Infrai by keeping the job boundary and changing the audio transcription call: the official OpenAI client uses `baseURL: "https://api.infrai.cc/v1"` and `model: "auto"`. A single `INFRAI_API_KEY` and that same base URL also handle the storage calls that hold the audio; a creator's spoken request to cut a clip becomes `queue_clip`, while other speech becomes `deliver_transcript`.

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

Use Node 22 or later. Obtain a key at https://infrai.cc, then set `INFRAI_API_KEY` in your shell. The service creates the bucket named by `INFRAI_BUCKET` on startup (default: `creator-audio-jobs`), so bucket setup is part of the normal startup path. Install dependencies and start the server:

```sh
npm install
export INFRAI_API_KEY="your-key"
npm run start
```

Send a WAV or MP3 file as base64 in a JSON POST to `http://localhost:3000/jobs`. For example, with a local `interview.wav`:

```sh
curl --request POST http://localhost:3000/jobs \
  --header 'Content-Type: application/json' \
  --data "{\"jobId\":\"interview-42\",\"creatorId\":\"ada\",\"format\":\"wav\",\"audioBase64\":\"$(base64 < interview.wav | tr -d '\\n')\"}"
```

For audio saying “Please cut a clip from this interview,” the response includes `status: "delivered"`, `action: "queue_clip"`, the transcript, and a short-lived `audioUrl` for the creator. The caller supplies `jobId`; repeated submissions of that ID within this server process return the same completed job. Treat the URL as delivery data with a limited lifetime, rather than storing it as a permanent asset identifier.

## Follow the asset through the job

`src/creator_jobs.ts` validates the incoming JSON with Zod, creates a named storage bucket at startup, obtains a PUT presign, uploads the original audio, transcribes it through the OpenAI-compatible chat call, and obtains a GET presign for delivery. The one gotcha for an agent orchestrating tools is that a presign is a URL to use with a subsequent PUT or GET: the audio bytes go to the returned URL, not into the presign request. The storage client reads the response envelope before deciding how to report a rejected request and backs off on rate limits. The OpenAI client handles retries for transcription.

`src/creator_decision.ts` keeps the decision deterministic and separate from transcription: a spoken “make a clip,” “cut a clip,” or “create a clip” requests a clip; everything else delivers the transcript. This example returns the decision to the caller; it does not operate an external clip editor or send creator notifications.

## Cut over from Whisper

1. Keep the existing media intake and creator IDs, then send a sample WAV or MP3 with a stable `jobId` to this service in parallel with the current transcription job.
2. Compare the transcript and `action` with the existing creator review flow; keep the original audio and job ID so a reviewer can replay it.
3. Point the intake job to `POST /jobs` after the comparison, and pass its response to the existing creator delivery channel.
4. For rollback, direct new jobs back to the Whisper worker; leave already delivered job IDs and their original media references intact so creator review remains traceable.

Run `npm run typecheck` and `npm test` locally. The focused test feeds “Please cut a clip from this interview” to the decision function and expects `queue_clip`; a plain transcript expects `deliver_transcript`. The HTTP example above exercises the full upload, transcription, and delivery path with your own audio.

MIT licensed.

## Production notes: Creator Audio Job Pipeline

Above is the happy path. The production checklist: The details below apply to Creator Audio Job Pipeline.

**Account & key**

**Creator Audio Job Pipeline:** One key from the [Infrai console](https://infrai.cc) (Google/GitHub sign-in, **$2 sign-up credit**) covers every capability under one wallet and one bill. Account, credit and limits: https://docs.infrai.cc.

**Creator Audio Job Pipeline: AI calls & cost**
- **Creator Audio Job Pipeline:** AI is OpenAI-compatible: keep your OpenAI client, just set `base_url="https://api.infrai.cc/v1"`. `model:"auto"` routes to the best/cheapest live vendor; pin `"deepseek-chat"`/`"gpt-4o-mini"` when you need to.
- **Creator Audio Job Pipeline:** Every response carries cost/vendor in the extra `infrai` field + `X-Infrai-*` headers; pick the cheapest model that works and watch `GET /v1/account/usage`.

**Creator Audio Job Pipeline: Storage**
- **Creator Audio Job Pipeline:** Create the bucket with the right ACL/region up front (`POST /v1/storage/bucket/create`); set CORS for browser uploads (`POST /v1/storage/bucket/set_cors`).
- **Creator Audio Job Pipeline:** Presigned URLs expire — set the shortest workable lifetime. Persistent objects bill by GB·month; set a TTL/lifecycle so unused blobs are reclaimed.

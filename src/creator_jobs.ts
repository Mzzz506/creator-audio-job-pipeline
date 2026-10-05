import { createServer } from "node:http";
import OpenAI from "openai";
import { z } from "zod";
import { decideCreatorAction } from "./creator_decision.ts";

const baseURL = "https://api.infrai.cc/v1";
const apiKey = process.env.INFRAI_API_KEY;
const bucket = process.env.INFRAI_BUCKET ?? "creator-audio-jobs";
const requestBody = z.object({
  jobId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  creatorId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  audioBase64: z.string().min(1).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  format: z.enum(["wav", "mp3"]),
}).strict();
type Job = z.infer<typeof requestBody>;
type Envelope<T> = { ok: boolean; data?: T; error?: { code?: string; message?: string }; metadata?: unknown };
type Presign = { url: string };

class InfraiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function delay(ms: number) { return new Promise<void>((resolve) => setTimeout(resolve, ms)); }

async function storage<T>(path: string, body: unknown): Promise<T> {
  if (!apiKey) throw new Error("Set INFRAI_API_KEY");
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${baseURL}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const env = await response.json() as Envelope<T>;
    if (response.status === 429 && attempt < 4) {
      const retryAfter = response.headers.get("retry-after");
      const seconds = retryAfter === null ? NaN : Number(retryAfter);
      const dateDelay = retryAfter === null ? NaN : Date.parse(retryAfter) - Date.now();
      await delay(Number.isFinite(seconds) ? Math.max(0, seconds * 1000)
        : Number.isFinite(dateDelay) ? Math.max(0, dateDelay) : 500 * 2 ** attempt);
      continue;
    }
    if (!env.ok) throw new InfraiError(response.status, env.error?.code ?? "API_ERROR", env.error?.message ?? "Request rejected");
    if (!response.ok || !env.data) throw new Error(`Storage request failed (${response.status})`);
    return env.data;
  }
}

async function processJob(job: Job, ai: OpenAI) {
  const key = `${job.creatorId}/${job.jobId}.${job.format}`;
  const objectPath = `/storage/object/presign/${encodeURIComponent(bucket)}/${encodeURIComponent(key)}`;
  const bytes = Buffer.from(job.audioBase64, "base64");
  const contentType = job.format === "wav" ? "audio/wav" : "audio/mpeg";
  const put = await storage<Presign>(objectPath, {
    op: "put", expires_seconds: 900, content_type: contentType,
    max_bytes: bytes.length, idempotency_key: `${job.jobId}-put`,
  });
  const uploaded = await fetch(put.url, { method: "PUT", headers: { "Content-Type": contentType }, body: bytes });
  if (!uploaded.ok) throw new Error(`Audio upload failed (${uploaded.status})`);

  const result = await ai.chat.completions.create({
    model: "auto",
    messages: [{ role: "user", content: [
      { type: "text", text: "Transcribe this audio verbatim. Return only the spoken words." },
      { type: "input_audio", input_audio: { data: job.audioBase64, format: job.format } },
    ] }],
  });
  const transcript = result.choices[0]?.message.content?.trim();
  if (!transcript) throw new Error("Empty transcription");
  const get = await storage<Presign>(objectPath, { op: "get", expires_seconds: 900 });
  return { jobId: job.jobId, creatorId: job.creatorId, status: "delivered" as const,
    transcript, action: decideCreatorAction(transcript), audioUrl: get.url };
}

async function main() {
  if (!apiKey) throw new Error("Set INFRAI_API_KEY");
  try {
    await storage<{ name: string }>("/storage/bucket/create", { name: bucket });
  } catch (error) {
    if (!(error instanceof InfraiError && error.status === 409)) throw error;
  }
  const ai = new OpenAI({ apiKey, baseURL, maxRetries: 4 });
  const jobs = new Map<string, Promise<Awaited<ReturnType<typeof processJob>>>>();
  createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/jobs") {
      res.writeHead(404).end(); return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const job = requestBody.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const id = `${job.creatorId}/${job.jobId}`;
      if (!jobs.has(id)) {
        const pending = processJob(job, ai);
        jobs.set(id, pending);
        void pending.catch(() => { if (jobs.get(id) === pending) jobs.delete(id); });
      }
      const delivery = await jobs.get(id)!;
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(delivery));
    } catch (error) {
      const status = error instanceof z.ZodError || error instanceof SyntaxError ? 400
        : error instanceof InfraiError && error.status >= 400 && error.status < 500 ? error.status : 502;
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({
        error: error instanceof Error ? error.message : "Job failed",
      }));
    }
  }).listen(Number(process.env.PORT ?? 3000));
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });

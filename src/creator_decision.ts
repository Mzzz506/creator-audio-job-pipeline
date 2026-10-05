export type CreatorAction = "queue_clip" | "deliver_transcript";

export function decideCreatorAction(transcript: string): CreatorAction {
  return /\b(make|cut|create)\s+(a\s+)?clip\b/i.test(transcript)
    ? "queue_clip"
    : "deliver_transcript";
}

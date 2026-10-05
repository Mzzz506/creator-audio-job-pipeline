import assert from "node:assert/strict";
import test from "node:test";
import { decideCreatorAction } from "./creator_decision.ts";

test("a spoken clip request enters the creator clip queue", () => {
  assert.equal(decideCreatorAction("Please cut a clip from this interview."), "queue_clip");
  assert.equal(decideCreatorAction("Here is the interview transcript."), "deliver_transcript");
});

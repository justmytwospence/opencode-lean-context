import { expect, test } from "vitest";
import { clip, clipTail, recentTexts } from "../src/transcript.ts";

const user = (text: string, synthetic = false) => ({ info: { role: "user" }, parts: [{ type: "text", text, synthetic }] });
const assistant = (...texts: string[]) => ({
  info: { role: "assistant" },
  parts: [{ type: "step-start" }, ...texts.map((text) => ({ type: "text", text })), { type: "tool", tool: "bash" }],
});

test("recentTexts: the latest user request and the assistant text since it", () => {
  expect(recentTexts([user("first"), assistant("Looking."), user("second"), assistant("Running", "the tests.")])).toEqual({
    user: "second",
    assistant: "Running\nthe tests.",
  });
  // Assistant text from an earlier turn does not count; synthetic user parts are skipped.
  expect(recentTexts([user("first"), assistant("Looking."), user("second")])).toEqual({ user: "second", assistant: "" });
  expect(recentTexts([user("real"), assistant("Done."), user("continue", true)])).toEqual({ user: "real", assistant: "Done." });
  expect(recentTexts([])).toEqual({ user: "", assistant: "" });
});

test("clip and clipTail mark the cut", () => {
  expect(clip("abcdef", 4)).toBe("abc…");
  expect(clipTail("abcdef", 4)).toBe("…def");
  expect(clip("abc", 4)).toBe("abc");
});

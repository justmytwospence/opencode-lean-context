import { expect, test } from "vitest";
import { DEFAULT_TRIM, assemble, makeBlocks, prefilter, trimFloor, trimQuestions } from "../src/trim.ts";

const log = Array.from({ length: 3_000 }, (_, i) => (i === 1_500 ? "FAIL test/parser.test.ts > parses empty input" : `  ✓ test ${i} passed`));

test("prefilter keeps head, tail, error lines with context, and a sample within budget", () => {
  const kept = prefilter(log, 20_000);
  expect(kept.slice(0, 40)).toEqual([...Array(40).keys()]);
  expect(kept).toContain(1_499);
  expect(kept).toContain(1_500);
  expect(kept).toContain(1_501);
  expect(kept).toContain(2_999);
  const chars = kept.reduce((sum, i) => sum + (log[i] as string).length + 1, 0);
  expect(chars).toBeLessThanOrEqual(20_000 + 200);
  expect(kept).toEqual([...kept].sort((a, b) => a - b));
});

test("makeBlocks groups candidates into at most maxBlocks blocks", () => {
  const blocks = makeBlocks(log, [...log.keys()], 150);
  expect(blocks).toHaveLength(150);
  expect(blocks[0]?.id).toBe("B001");
  expect(blocks.flatMap((b) => b.lines)).toHaveLength(3_000);
  const questions = trimQuestions(blocks);
  expect(questions["block::B150"]?.instructions).toMatch(/output\.B150/u);
  expect(questions.needs_all?.type).toBe("noul");
});

test("assemble keeps order, marks omissions and points at the full output", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
  const blocks = makeBlocks(lines, [...lines.keys()], 10);
  const result = assemble(lines, [blocks[4]!], { ...DEFAULT_TRIM, headLines: 2, tailLines: 3 }, "/tmp/full.txt");
  expect(result.keptLines).toBe(15);
  expect(result.text).toContain("line 0\nline 1\n[… 38 lines omitted …]\nline 40");
  expect(result.text).toContain("line 49\n[… 47 lines omitted …]\nline 97");
  expect(result.text).toMatch(/Full output: \/tmp\/full\.txt \(read it with offset\/limit\)/u);
});

test("trimFloor: which tools are trimmed and from what size", () => {
  expect(trimFloor("bash", DEFAULT_TRIM)).toBe(12_000);
  expect(trimFloor("grep", DEFAULT_TRIM)).toBe(12_000);
  expect(trimFloor("glob", DEFAULT_TRIM)).toBe(12_000);
  expect(trimFloor("list", DEFAULT_TRIM)).toBe(12_000);
  expect(trimFloor("webfetch", DEFAULT_TRIM)).toBe(12_000);
  expect(trimFloor("websearch", DEFAULT_TRIM)).toBe(12_000);
  expect(trimFloor("context7_query-docs", DEFAULT_TRIM)).toBe(12_000);
  expect(trimFloor("read", DEFAULT_TRIM)).toBe(50_000);
  expect(trimFloor("edit", DEFAULT_TRIM)).toBeUndefined();
  expect(trimFloor("write", DEFAULT_TRIM)).toBeUndefined();
  expect(trimFloor("apply_patch", DEFAULT_TRIM)).toBeUndefined();
  expect(trimFloor("task", DEFAULT_TRIM)).toBeUndefined();
  expect(trimFloor("todowrite", DEFAULT_TRIM)).toBeUndefined();
  expect(trimFloor("skill", DEFAULT_TRIM)).toBeUndefined();
});

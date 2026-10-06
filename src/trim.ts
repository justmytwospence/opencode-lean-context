// Trimming large tool output to the blocks the agent needs, ported unchanged from pi-lean-context
// except for the question type (`noul` on Jev's HTTP API) and opencode's tool names.
import type { Question } from "./jev.ts";

export interface TrimSettings {
  /** Trim text results longer than this many characters. */
  minChars: number;
  /** For `read`, trim only results longer than this. */
  readMinChars: number;
  /** At most this many blocks are judged. */
  maxBlocks: number;
  /** Characters of output sent to Jev; larger output is pre-filtered first. */
  stateBudgetChars: number;
  /** Keep blocks whose probability of being needed reaches this. */
  keepThreshold: number;
  /** Do not trim when Jev thinks the agent asked for the whole output. */
  needsAllThreshold: number;
  /** Do not trim when more than this share of lines would be kept. */
  maxKeptShare: number;
  headLines: number;
  tailLines: number;
}

export const DEFAULT_TRIM: TrimSettings = {
  minChars: 12_000,
  readMinChars: 50_000,
  maxBlocks: 150,
  stateBudgetChars: 60_000,
  keepThreshold: 0.4,
  needsAllThreshold: 0.6,
  maxKeptShare: 0.7,
  headLines: 5,
  tailLines: 20,
};

const SIGNAL = /error|\bERR!?\b|warn|fail|panic|assert|exception|traceback|fatal|could not|cannot|can't|not found|denied|refused|conflict|exit code|✗|×/iu;

export interface Block {
  id: string;
  /** Line indices (0-based) of the original output in this block. */
  lines: number[];
  text: string;
}

/**
 * Lines worth judging when the output is too large for one request: the first 40, the last 80,
 * every line that looks like an error or warning (with two lines of context), and an even sample
 * of the rest up to the budget.
 */
export function prefilter(lines: readonly string[], budgetChars: number): number[] {
  const n = lines.length;
  const keep = new Set<number>();
  for (let i = 0; i < Math.min(40, n); i++) keep.add(i);
  for (let i = Math.max(0, n - 80); i < n; i++) keep.add(i);
  for (let i = 0; i < n; i++) {
    if (SIGNAL.test(lines[i] as string)) {
      for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) keep.add(j);
    }
  }
  let used = [...keep].reduce((sum, i) => sum + (lines[i] as string).length + 1, 0);
  const rest = [...Array(n).keys()].filter((i) => !keep.has(i));
  if (rest.length && used < budgetChars) {
    const average = rest.reduce((sum, i) => sum + (lines[i] as string).length + 1, 0) / rest.length || 1;
    const room = Math.floor((budgetChars - used) / average);
    const step = Math.max(1, Math.ceil(rest.length / Math.max(1, room)));
    for (let k = 0; k < rest.length; k += step) {
      const i = rest[k] as number;
      const size = (lines[i] as string).length + 1;
      if (used + size > budgetChars) break;
      keep.add(i);
      used += size;
    }
  }
  return [...keep].sort((a, b) => a - b);
}

/** Group the candidate lines into at most `maxBlocks` blocks of consecutive candidates. */
export function makeBlocks(lines: readonly string[], candidates: readonly number[], maxBlocks: number): Block[] {
  const size = Math.max(1, Math.ceil(candidates.length / maxBlocks));
  const blocks: Block[] = [];
  for (let k = 0; k < candidates.length; k += size) {
    const group = candidates.slice(k, k + size);
    const id = `B${String(blocks.length + 1).padStart(3, "0")}`;
    blocks.push({ id, lines: group, text: group.map((i) => clipLine(lines[i] as string)).join("\n") });
  }
  return blocks;
}

function clipLine(line: string) {
  return line.length > 400 ? `${line.slice(0, 399)}…` : line;
}

export function trimQuestions(blocks: readonly Block[]): Record<string, Question> {
  const questions: Record<string, Question> = {
    needs_all: {
      type: "noul",
      instructions:
        "Given `intent`, did the agent run this to read the complete output verbatim (for example to copy, review, or count all of it), rather than to find specific results in it?",
      criteria: { true: "The agent needs the whole output", false: "The agent needs only the relevant parts" },
    },
  };
  for (const block of blocks) {
    questions[`block::${block.id}`] = {
      type: "noul",
      instructions: `Does \`output.${block.id}\` contain information the agent needs for \`intent\`: errors, failures, warnings, requested values, or results it would act on?`,
      criteria: {
        true: "The agent should read these lines",
        false: "Routine progress, passing output, boilerplate, or repetition the agent can skip",
      },
    };
  }
  return questions;
}

export interface Assembly {
  text: string;
  keptLines: number;
  totalLines: number;
}

/**
 * The kept lines (kept blocks plus the head and tail) in original order, with
 * `[… N lines omitted …]` markers, and a footer pointing at the full output.
 */
export function assemble(lines: readonly string[], keptBlocks: readonly Block[], settings: TrimSettings, fullPath: string): Assembly {
  const keep = new Set<number>();
  for (let i = 0; i < Math.min(settings.headLines, lines.length); i++) keep.add(i);
  for (let i = Math.max(0, lines.length - settings.tailLines); i < lines.length; i++) keep.add(i);
  for (const block of keptBlocks) for (const i of block.lines) keep.add(i);
  const out: string[] = [];
  let omitted = 0;
  for (let i = 0; i < lines.length; i++) {
    if (keep.has(i)) {
      if (omitted) out.push(`[… ${omitted} line${omitted === 1 ? "" : "s"} omitted …]`);
      omitted = 0;
      out.push(lines[i] as string);
    } else omitted++;
  }
  if (omitted) out.push(`[… ${omitted} line${omitted === 1 ? "" : "s"} omitted …]`);
  out.push(
    "",
    `[lean-context: kept ${keep.size} of ${lines.length} lines that matter for this step. Full output: ${fullPath} (read it with offset/limit).]`,
  );
  return { text: out.join("\n"), keptLines: keep.size, totalLines: lines.length };
}

/** opencode's built-in tools whose output must stay whole: edits, plans, subagent answers, skills. */
const WHOLE = new Set(["edit", "write", "apply_patch", "patch", "multiedit", "task", "todowrite", "todoread", "skill", "question", "lsp", "invalid", "batch"]);

/**
 * Which tools' output may be trimmed, and from what size: `read` from `readMinChars`; `bash`,
 * `grep`, `glob`, `list`, `webfetch`, `websearch`, MCP tools (`<server>_<tool>`) and other
 * plugin tools from `minChars`.
 */
export function trimFloor(tool: string, settings: TrimSettings): number | undefined {
  if (tool === "read") return settings.readMinChars;
  if (WHOLE.has(tool)) return undefined;
  return settings.minChars;
}

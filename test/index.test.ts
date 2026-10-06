import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { DEFAULT_OPTIONS, NAME, type Options, createHooks, currentOptions, resolveOptions, savePath } from "../src/index.ts";

process.env.XDG_DATA_HOME = mkdtempSync("/tmp/lean-");
process.env.XDG_CONFIG_HOME = mkdtempSync("/tmp/lean-config-");

const big = Array.from({ length: 2_000 }, (_, i) => (i === 1_000 ? "Error: expected 3 retries, got 1" : `ok ${i} ${"-".repeat(10)}`)).join("\n");

type Answer = (questions: Record<string, unknown>, state: any) => unknown;

/** Jev answers that keep the blocks mentioning an error. */
const keepErrors: Answer = (questions, state) =>
  Object.fromEntries(
    Object.keys(questions).map((id) => {
      const block = id.startsWith("block::") ? String(state?.output?.[id.slice(7)] ?? "") : "";
      return [id, { type: "noul", noul: block.includes("Error") ? 0.9 : 0.05 }];
    }),
  );

const history = [
  { info: { role: "user" }, parts: [{ type: "text", text: "Fix the retry test" }] },
  { info: { role: "assistant" }, parts: [{ type: "text", text: "Running the tests." }, { type: "tool", tool: "bash" }] },
];

function setup(answer: Answer, opts: { key?: string; options?: Partial<Options> | (() => Options) } = {}) {
  process.env.TYPESAFE_API_KEY = opts.key ?? "k";
  const sent: any[] = [];
  const logs: string[] = [];
  const toasts: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    sent.push(body);
    const answers = answer(body.questions, body.state);
    if (answers instanceof Response) return answers;
    if (answers instanceof Error) throw answers;
    return new Response(JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 300 } }));
  }) as unknown as typeof fetch;
  const client = {
    session: { messages: async () => ({ data: history }) },
    app: { log: async ({ body }: { body: { message: string } }) => (logs.push(body.message), {}) },
    tui: { showToast: async ({ body }: { body: { message: string } }) => (toasts.push(body.message), {}) },
  };
  const options = typeof opts.options === "function" ? opts.options : { ...DEFAULT_OPTIONS, ...opts.options };
  const hooks = createHooks(client as never, options, fetchImpl);
  return { hooks, sent, logs, toasts };
}

async function run(hooks: Awaited<ReturnType<typeof createHooks>>, text = big, call: { tool?: string; callID?: string; args?: unknown } = {}) {
  const output = { title: "npm test", output: text, metadata: {} };
  await hooks["tool.execute.after"]!(
    { tool: call.tool ?? "bash", sessionID: "ses_1", callID: call.callID ?? "call_1", args: call.args ?? { command: "npm test" } },
    output,
  );
  return output.output;
}

test("large output is trimmed to the needed blocks and saved in full", async () => {
  const s = setup(keepErrors);
  const hooks = await s.hooks;
  const text = await run(hooks);
  expect(text).toContain("Error: expected 3 retries, got 1");
  expect(text).toMatch(/\[… \d+ lines omitted …\]/u);
  expect(text.length).toBeLessThan(big.length / 5);
  const full = /Full output: (\S+)/u.exec(text)?.[1] as string;
  expect(full).toBe(savePath("ses_1", "call_1"));
  expect(readFileSync(full, "utf8")).toBe(big);
  expect(s.sent[0].state.intent).toMatchObject({ user_request: "Fix the retry test", agent_said: "Running the tests.", tool: "bash" });
  expect(s.sent[0].questions.needs_all.type).toBe("noul");
  expect(s.logs[0]).toMatch(/^bash: kept \d+ of 2000 lines, about \d+k tokens saved \(needs_all 0\.05, \d+ blocks, \d+ ms, 300 tokens\); full output /u);
  expect(s.toasts).toHaveLength(1);

  // Asking for the same thing again in the same turn returns it in full; a new turn trims again.
  expect(await run(hooks, big, { callID: "call_2" })).toBe(big);
  expect(s.sent).toHaveLength(1);
  await hooks["chat.message"]!({ sessionID: "ses_1" }, { message: {} as never, parts: [] });
  expect(await run(hooks, big, { callID: "call_3" })).not.toBe(big);
  expect(s.sent).toHaveLength(2);
});

test("no trim when the agent needs it all or most would be kept", async () => {
  const needsAll = setup((q, st) => ({ ...(keepErrors(q, st) as object), needs_all: { type: "noul", noul: 0.9 } }));
  expect(await run(await needsAll.hooks)).toBe(big);
  expect(needsAll.logs[0]).toMatch(/^bash: left whole, \d+ of 2000 lines needed \(needs_all 0\.90/u);
  const most = setup((q) => Object.fromEntries(Object.keys(q).map((id) => [id, { type: "noul", noul: id === "needs_all" ? 0 : 0.8 }])));
  expect(await run(await most.hooks)).toBe(big);
  expect(most.toasts).toEqual([]);
});

test("Jev failures leave the output untouched", async () => {
  const down = setup(() => new Response("boom", { status: 500 }));
  expect(await run(await down.hooks)).toBe(big);
  expect(down.logs).toEqual(["bash: left whole, Jev unavailable (HTTP 500)"]);
  const thrown = setup(() => new Error("socket hang up"));
  expect(await run(await thrown.hooks)).toBe(big);
  expect(thrown.logs[0]).toContain("socket hang up");
  const noKey = setup(keepErrors, { key: "" });
  expect(await run(await noKey.hooks)).toBe(big);
  expect(noKey.sent).toEqual([]);
  expect(noKey.logs).toEqual(["bash: left whole, Jev unavailable (TYPESAFE_API_KEY is not set)"]);
});

test("small output, whole-output tools and a disabled plugin pass through without Jev", async () => {
  const s = setup(keepErrors);
  const hooks = await s.hooks;
  expect(await run(hooks, "ok")).toBe("ok");
  expect(await run(hooks, big, { tool: "edit" })).toBe(big);
  expect(await run(hooks, big, { tool: "task" })).toBe(big);
  expect(await run(hooks, big.slice(0, 40_000), { tool: "read" })).toBe(big.slice(0, 40_000));
  const off = setup(keepErrors, { options: { enabled: false } });
  expect(await run(await off.hooks)).toBe(big);
  expect(s.sent).toEqual([]);
  expect(off.sent).toEqual([]);
});

test("options merge over the defaults", () => {
  const o = resolveOptions({ toast: false, trim: { minChars: 8_000 }, jev: { timeoutMs: 5_000 } });
  expect(o.toast).toBe(false);
  expect(o.trim.minChars).toBe(8_000);
  expect(o.trim.readMinChars).toBe(50_000);
  expect(o.jev).toEqual({ model: "jev-latest", timeoutMs: 5_000 });
  expect(resolveOptions(undefined)).toEqual(DEFAULT_OPTIONS);
});

test("the shared settings files are read on each tool call, so edits apply without a restart", async () => {
  const project = "/tmp/lean-project-none";
  const file = path.join(process.env.XDG_CONFIG_HOME as string, "agents", `${NAME}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ enabled: false }));
  utimesSync(file, 1_000, 1_000);
  const s = setup(keepErrors, { options: () => currentOptions({ toast: false }, project) });
  const hooks = await s.hooks;
  expect(await run(hooks)).toBe(big);
  expect(s.sent).toEqual([]);

  writeFileSync(file, JSON.stringify({ enabled: true }));
  utimesSync(file, 2_000, 2_000);
  expect(await run(hooks, big, { callID: "call_live" })).not.toBe(big);
  expect(s.sent).toHaveLength(1);
  expect(s.toasts).toEqual([]);
});

test("savePath keeps ids safe for the file system", () => {
  expect(savePath("ses/1", "call:2")).toMatch(/\/opencode\/lean-context\/ses_1\/call_2\.txt$/u);
});

test("when opencode truncated the output, Jev picks from the full output it saved", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const dir = `${process.env.XDG_DATA_HOME}/opencode/tool-output`;
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/tool_1`;
  writeFileSync(file, big);
  // opencode's preview: the last lines only, which do not include the error at line 1000.
  const tail = big.split("\n").slice(-900).join("\n");
  const preview = `...1100 lines truncated...\n\nThe tool call succeeded but the output was truncated. Full output saved to: ${file}\nUse Grep to search the full content.\n\n${tail}`;
  const s = setup(keepErrors);
  const text = await run(await s.hooks, preview);
  expect(text).toContain("Error: expected 3 retries, got 1");
  expect(text.length).toBeLessThan(preview.length);

  // A path outside opencode's tool-output directory is never read.
  const { untruncated } = await import("../src/index.ts");
  expect(untruncated("Full output saved to: /etc/passwd")).toBeUndefined();
  expect(untruncated(`Full output saved to: ${file}`)).toBe(big);
});

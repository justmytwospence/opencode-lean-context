// The agent's current step, read from the session's messages (`client.session.messages`): the
// latest user request and what the assistant has said since. Ported from pi-lean-context, where
// the same two texts came from the session branch.

/** The part of an opencode message (`{ info, parts }`) this reads. */
export interface MessageLike {
  info: { role: string };
  parts: readonly { type: string; text?: string; synthetic?: boolean }[];
}

/** The text a user typed, or an assistant wrote: text parts that are not synthetic. */
export function messageText(message: MessageLike): string {
  return message.parts
    .filter((p) => p.type === "text" && !p.synthetic && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

/** The latest user message and the latest assistant text since it. */
export function recentTexts(messages: readonly MessageLike[]): { user: string; assistant: string } {
  let user = "";
  let assistant = "";
  for (let i = messages.length - 1; i >= 0 && (!user || !assistant); i--) {
    const message = messages[i] as MessageLike;
    const text = messageText(message).trim();
    if (!text) continue;
    if (!user && message.info.role === "user") user = text;
    if (!assistant && !user && message.info.role === "assistant") assistant = text;
  }
  return { user, assistant };
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function clipTail(text: string, max: number): string {
  return text.length > max ? `…${text.slice(-(max - 1))}` : text;
}

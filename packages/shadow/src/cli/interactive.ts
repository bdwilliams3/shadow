export type InteractiveCommand =
  | "actions"
  | "approve"
  | "approvals"
  | "btw"
  | "budget"
  | "cancel"
  | "diff"
  | "exit"
  | "help"
  | "models"
  | "plan"
  | "preflight"
  | "reject"
  | "steer"
  | "status";

export type ConversationDecision = "keep_thinking" | "change_directions" | "start_coding";

export type InteractiveInput =
  | { kind: "empty" }
  | { kind: "exit" }
  | { kind: "command"; command: Exclude<InteractiveCommand, "exit">; args: string[] }
  | { kind: "request"; request: string; decision: ConversationDecision }
  | { kind: "chat"; message: string; decision: Exclude<ConversationDecision, "start_coding"> }
  | { kind: "incomplete"; message: string }
  | { kind: "unknown"; command: string };

const commandAliases: Record<string, InteractiveCommand> = {
  "?": "help",
  action: "actions",
  actions: "actions",
  approve: "approve",
  approval: "approvals",
  approvals: "approvals",
  btw: "btw",
  budget: "budget",
  cancel: "cancel",
  diff: "diff",
  exit: "exit",
  help: "help",
  model: "models",
  models: "models",
  plan: "plan",
  preflight: "preflight",
  q: "exit",
  quit: "exit",
  reject: "reject",
  steer: "steer",
  status: "status"
};

const actionStarts = new Set([
  "add",
  "apply",
  "build",
  "change",
  "code",
  "create",
  "delete",
  "develop",
  "document",
  "fix",
  "generate",
  "implement",
  "make",
  "patch",
  "refactor",
  "remove",
  "rename",
  "repair",
  "replace",
  "run",
  "start",
  "test",
  "update",
  "validate",
  "write"
]);

const questionStarts = new Set([
  "hello",
  "hey",
  "hi",
  "how",
  "what",
  "whats",
  "what's",
  "when",
  "where",
  "which",
  "who",
  "why"
]);

const discussionStarts = new Set([
  "describe",
  "discuss",
  "explain",
  "inspect",
  "summarize",
  "tell"
]);

export function parseInteractiveInput(raw: string): InteractiveInput {
  const line = raw.trim();
  if (line.length === 0) {
    return { kind: "empty" };
  }

  const [first = "", ...args] = line.split(/\s+/);
  const slashCommand = first.startsWith("/");
  const commandToken = normalizeCommandToken(first);
  const command = commandAliases[commandToken];
  if (command) {
    return command === "exit"
      ? { kind: "exit" }
      : { kind: "command", command, args };
  }
  if (slashCommand) {
    return { kind: "unknown", command: first };
  }
  if (args.length === 0) {
    return {
      kind: "incomplete",
      message:
        `I did not start a run for '${line}'. Type /help for commands, or describe the change in a full sentence.`
    };
  }

  const decision = decideConversation(line);
  if (decision === "start_coding") {
    return { kind: "request", request: line, decision };
  }
  return { kind: "chat", message: line, decision };
}

function normalizeCommandToken(token: string): string {
  return token
    .toLowerCase()
    .replace(/^\/+/, "")
    .replace(/[/:]+$/u, "");
}

export function decideConversation(raw: string): ConversationDecision {
  const words = raw
    .trim()
    .toLowerCase()
    .replace(/[?!.,:;]+/gu, "")
    .split(/\s+/)
    .filter(Boolean);
  const first = words[0] ?? "";
  const second = words[1] ?? "";
  const third = words[2] ?? "";

  if (first === "btw" || first === "steer") {
    return "change_directions";
  }
  if (questionStarts.has(first)) {
    if ((first === "can" || first === "could" || first === "please") && actionStarts.has(second)) {
      return "start_coding";
    }
    return "keep_thinking";
  }
  if ((first === "can" || first === "could") && second === "you" && actionStarts.has(third)) {
    return "start_coding";
  }
  if (first === "please" && actionStarts.has(second)) {
    return "start_coding";
  }
  if (discussionStarts.has(first)) {
    return "keep_thinking";
  }
  if (words.some((word) => word === "capabilities" || word === "capability")) {
    return "keep_thinking";
  }
  if (actionStarts.has(first)) {
    return "start_coding";
  }

  return "keep_thinking";
}

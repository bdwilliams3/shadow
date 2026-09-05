import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { relative } from "node:path";
import type { ProcessResult } from "./types.js";

const inheritedEnvironmentNames = [
  "CI",
  "FORCE_COLOR",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "NO_COLOR",
  "NODE_ENV",
  "PATH",
  "SHELL",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "WINDIR"
];

function safeEnvironment(additionalNames: readonly string[] = []): NodeJS.ProcessEnv {
  const names = new Set([...inheritedEnvironmentNames, ...additionalNames]);
  return Object.fromEntries(
    [...names].flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    })
  );
}

function assertInsideWorkspace(workspaceRoot: string, cwd: string): void {
  const path = relative(workspaceRoot, cwd);
  if (path === ".." || path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error(`Command working directory is outside the workspace: ${cwd}`);
  }
}

export async function executeProcess(
  command: string[],
  options: {
    workspaceRoot: string;
    cwd: string;
    timeoutMs: number;
    maxOutputBytes: number;
    signal: AbortSignal;
    stdin?: string;
    environmentNames?: string[];
  }
): Promise<ProcessResult> {
  const executable = command[0];
  if (!executable) {
    throw new Error("Command must contain an executable");
  }
  const [workspaceRoot, cwd] = await Promise.all([
    realpath(options.workspaceRoot),
    realpath(options.cwd)
  ]);
  assertInsideWorkspace(workspaceRoot, cwd);

  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(executable, command.slice(1), {
      cwd,
      env: safeEnvironment(options.environmentNames),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"] as const
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let spawnError: Error | undefined;

    // A child that traps SIGTERM would otherwise keep "close" from ever firing and hang
    // the caller with no CPU and no children to point at. Escalate after a grace period.
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const terminate = (): void => {
      child.kill("SIGTERM");
      if (!escalation) {
        escalation = setTimeout(() => child.kill("SIGKILL"), 5_000);
        escalation.unref();
      }
    };

    const capture = (target: Buffer[], chunk: Buffer): void => {
      const remaining = Math.max(0, options.maxOutputBytes - capturedBytes);
      if (remaining > 0) {
        const accepted = chunk.subarray(0, remaining);
        target.push(accepted);
        capturedBytes += accepted.byteLength;
      }
      if (chunk.byteLength > remaining && !outputLimitExceeded) {
        outputLimitExceeded = true;
        terminate();
      }
    };

    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.on("error", (error) => {
      spawnError = error;
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);

    const abort = (): void => {
      terminate();
    };
    options.signal.addEventListener("abort", abort, { once: true });
    child.stdin.on("error", () => {
      // The process may close stdin early after reporting a validation error.
    });
    child.stdin.end(options.stdin);

    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      if (escalation) {
        clearTimeout(escalation);
      }
      options.signal.removeEventListener("abort", abort);
      if (spawnError) {
        rejectProcess(spawnError);
        return;
      }
      resolveProcess({
        command,
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        outputLimitExceeded
      });
    });
  });
}

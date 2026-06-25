import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as cp from "child_process";
import { load as yamlLoad } from "js-yaml";

const FORMAT_PATTERN = /(^|[-_])format([-_]|$)/i;

interface Hook {
  id: string;
  alias?: string;
}

interface Repo {
  hooks: Hook[];
}

interface PreCommitConfig {
  repos: Repo[];
}

let outputChannel: vscode.OutputChannel;
const runningFiles = new Set<string>();

function debug(message: string): void {
  const cfg = vscode.workspace.getConfiguration("pre-commit-vscode");
  if (cfg.get<boolean>("debug", false)) {
    outputChannel.appendLine(`[debug] ${message}`);
  }
}

/**
 * Walks up the directory tree from `startDir` until it finds a
 * `.pre-commit-config.yaml` file, returning its absolute path. Returns
 * `undefined` if the filesystem root is reached without finding one.
 */
function findConfig(startDir: string): string | undefined {
  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, ".pre-commit-config.yaml");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/**
 * Partitions all hooks in `config` into two groups:
 * - format hooks: those whose `alias` matches the FORMAT_PATTERN
 * - everything else: collected into `skipIds` to be passed via the SKIP var
 */
function buildSkipList(config: PreCommitConfig): {
  hasFormatHooks: boolean;
  skipIds: string[];
} {
  const skipIds: string[] = [];
  let hasFormatHooks = false;

  for (const repo of config.repos ?? []) {
    for (const hook of repo.hooks ?? []) {
      if (hook.alias && FORMAT_PATTERN.test(hook.alias)) {
        hasFormatHooks = true;
      } else {
        skipIds.push(hook.id);
      }
    }
  }

  return { hasFormatHooks, skipIds };
}

/**
 * Spawns `pre-commit run --files <filePath>` with `SKIP=<skipIds>` in the
 * environment, cwd set to the directory containing `.pre-commit-config.yaml`.
 * Kills the process and resolves with `code: null` if `timeoutMs` elapses.
 * Resolves (never rejects) so the caller always gets stdout/stderr for logging.
 */
function runPreCommit(
  filePath: string,
  configDir: string,
  skipIds: string[],
  timeoutMs: number,
  executable: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (skipIds.length > 0) {
      env["SKIP"] = skipIds.join(",");
    }

    debug(`spawn: ${executable} run --files ${filePath} (cwd: ${configDir}, SKIP: ${env["SKIP"] ?? ""})`);

    const proc = cp.spawn(executable, ["run", "--files", filePath], {
      cwd: configDir,
      env,
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      proc.kill();
      outputChannel.appendLine(
        `[pre-commit] Timed out after ${timeoutMs / 1000}s: ${filePath}`,
      );
      resolve({ code: null, stdout, stderr });
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      debug(`exit code: ${code}`);
      resolve({ code, stdout, stderr });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      outputChannel.appendLine(`[pre-commit] Failed to start: ${err.message}`);
      resolve({ code: null, stdout, stderr });
    });
  });
}

/**
 * Fired on every `onDidSaveTextDocument` event. Runs the format hooks defined
 * in the nearest `.pre-commit-config.yaml` on the saved file and, if pre-commit
 * modifies it, replaces the entire buffer content with the new disk content.
 *
 * No-ops when: the URI scheme is not `file`, a run for this path is already in
 * progress, no config is found up the tree, or no format-aliased hooks exist.
 * Non-zero exit codes are written to the "pre-commit" Output Channel.
 */
async function handleSave(document: vscode.TextDocument): Promise<void> {
  debug(`save: ${document.uri.toString()}`);

  if (document.uri.scheme !== "file") {
    debug(`skipped: not a file URI`);
    return;
  }

  const filePath = document.uri.fsPath;
  if (runningFiles.has(filePath)) {
    debug(`skipped: run already in progress`);
    return;
  }

  const configPath = findConfig(path.dirname(filePath));
  debug(`config: ${configPath ?? "not found"}`);
  if (!configPath) {
    return;
  }

  let config: PreCommitConfig;
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    config = yamlLoad(raw) as PreCommitConfig;
  } catch {
    debug(`failed to parse config`);
    return;
  }

  const { hasFormatHooks, skipIds } = buildSkipList(config);
  debug(`hasFormatHooks: ${hasFormatHooks}, skipIds: [${skipIds.join(", ")}]`);
  if (!hasFormatHooks) {
    return;
  }

  runningFiles.add(filePath);
  try {
    const cfg = vscode.workspace.getConfiguration("pre-commit-vscode");
    const executable = cfg.get<string>("executablePath", "pre-commit");
    const timeoutMs = cfg.get<number>("timeout", 10) * 1000;

    const { code, stdout, stderr } = await runPreCommit(
      filePath,
      path.dirname(configPath),
      skipIds,
      timeoutMs,
      executable,
    );

    if (code !== 0) {
      outputChannel.appendLine(
        `[pre-commit] Exit ${code ?? "timeout"}: ${filePath}`,
      );
      if (stdout) {
        outputChannel.appendLine(stdout);
      }
      if (stderr) {
        outputChannel.appendLine(stderr);
      }
    }

    const diskContent = fs.readFileSync(filePath, "utf-8");
    if (diskContent === document.getText()) {
      debug(`file unchanged after pre-commit`);
      return;
    }

    debug(`applying formatted content to buffer`);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      document.uri,
      new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length),
      ),
      diskContent,
    );
    await vscode.workspace.applyEdit(edit);
    await document.save();
  } finally {
    runningFiles.delete(filePath);
  }
}

/**
 * Extension entry point. Creates the "pre-commit" Output Channel, registers
 * the save handler, and registers a no-op DocumentFormattingEditProvider so
 * users can set this extension as `editor.defaultFormatter` for a language,
 * suppressing conflicting formatters (e.g. Prettier) without disabling
 * `editor.formatOnSave` globally. Called once by VS Code on `onStartupFinished`.
 */
export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("pre-commit");
  context.subscriptions.push(outputChannel);
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(handleSave),
  );
  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider(
      { scheme: "file", pattern: "**/*" },
      { provideDocumentFormattingEdits: () => [] },
    ),
  );
}

export function deactivate(): void {}

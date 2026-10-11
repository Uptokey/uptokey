/**
 * Uptokey TUI — Git integration service.
 * Provides status, diff, staging, and commit operations via git CLI.
 * Runs in the project root directory.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MAX_BUFFER = 10 * 1024 * 1024; // 10MB

export interface GitStatus {
  branch: string;
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: string[];
  ahead: number;
  behind: number;
}

export interface GitFileChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied";
}

export interface GitCommitResult {
  hash: string;
  message: string;
  filesChanged: number;
}

export class GitService {
  private cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /** Check if the directory is a Git repo. */
  async isRepo(): Promise<boolean> {
    try {
      await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd: this.cwd, timeout: 5000, maxBuffer: MAX_BUFFER });
      return true;
    } catch {
      return false;
    }
  }

  /** Get current git status. */
  async status(): Promise<GitStatus> {
    const { stdout: branchOut } = await exec("git", ["branch", "--show-current"], { cwd: this.cwd, timeout: 5000, maxBuffer: MAX_BUFFER });
    const branch = branchOut.trim();

    const { stdout: statusOut } = await exec("git", ["status", "--porcelain=v1"], { cwd: this.cwd, timeout: 5000, maxBuffer: MAX_BUFFER });
    const staged: GitFileChange[] = [];
    const unstaged: GitFileChange[] = [];
    const untracked: string[] = [];

    for (const line of statusOut.split("\n").filter(Boolean)) {
      const indexStatus = line[0];
      const workStatus = line[1];
      const path = line.slice(3).trim();

      if (indexStatus === "?" && workStatus === "?") {
        untracked.push(path);
        continue;
      }
      if (indexStatus && indexStatus !== " " && indexStatus !== "?") {
        staged.push({ path, status: parseStatus(indexStatus) });
      }
      if (workStatus && workStatus !== " " && workStatus !== "?") {
        unstaged.push({ path, status: parseStatus(workStatus) });
      }
    }

    let ahead = 0, behind = 0;
    try {
      const { stdout: revOut } = await exec("git", ["rev-list", "--left-right", "--count", "HEAD...@{u}"], { cwd: this.cwd, timeout: 5000, maxBuffer: MAX_BUFFER });
      const parts = revOut.trim().split(/\s+/);
      ahead = parseInt(parts[0] ?? "0", 10);
      behind = parseInt(parts[1] ?? "0", 10);
    } catch { /* no upstream */ }

    return { branch, staged, unstaged, untracked, ahead, behind };
  }

  /** Get diff of working directory or staged changes. */
  async diff(staged = false): Promise<string> {
    const args = staged ? ["diff", "--staged"] : ["diff"];
    const { stdout } = await exec("git", args, { cwd: this.cwd, timeout: 10000, maxBuffer: MAX_BUFFER });
    return stdout;
  }

  /** Stage files. */
  async add(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await exec("git", ["add", ...paths], { cwd: this.cwd, timeout: 5000, maxBuffer: MAX_BUFFER });
  }

  /** Unstage files. */
  async reset(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await exec("git", ["reset", "HEAD", ...paths], { cwd: this.cwd, timeout: 5000, maxBuffer: MAX_BUFFER });
  }

  /** Commit staged changes. */
  async commit(message: string): Promise<GitCommitResult> {
    const { stdout } = await exec("git", ["commit", "-m", message], { cwd: this.cwd, timeout: 10000, maxBuffer: MAX_BUFFER });
    const hashMatch = stdout.match(/\[.+ ([a-f0-9]+)\]/);
    const filesMatch = stdout.match(/(\d+) files? changed/);
    return {
      hash: hashMatch?.[1] ?? "unknown",
      message,
      filesChanged: parseInt(filesMatch?.[1] ?? "0", 10),
    };
  }

  /** Get log entries. */
  async log(count = 10): Promise<Array<{ hash: string; message: string; author: string; date: string }>> {
    const { stdout } = await exec("git", ["log", `--max-count=${count}`, "--format=%H\t%s\t%an\t%aI"], { cwd: this.cwd, timeout: 5000, maxBuffer: MAX_BUFFER });
    return stdout.split("\n").filter(Boolean).map((line) => {
      const [hash, message, author, date] = line.split("\t");
      return { hash: hash ?? "", message: message ?? "", author: author ?? "", date: date ?? "" };
    });
  }
}

function parseStatus(char: string): GitFileChange["status"] {
  switch (char) {
    case "A": return "added";
    case "M": return "modified";
    case "D": return "deleted";
    case "R": return "renamed";
    case "C": return "copied";
    default: return "modified";
  }
}

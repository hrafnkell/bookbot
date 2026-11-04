import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

export type BotStatus = "disconnected" | "connected" | "searching" | "downloading" | "lines_ready" | "idle";

export interface DownloadProgress {
  filename: string;
  received: number;
  total: number;
}

const now = () => Date.now() / 1000;

/** Central runtime state shared by the IRC side and the web server. */
export class BotState {
  status: BotStatus = "disconnected";
  searchTerm: string | null = null;
  downloadProgress: DownloadProgress = { filename: "", received: 0, total: 0 };
  extractedLines: string[] | null = null;
  files: string[] = [];
  error: string | null = null;
  lastActivity = now();
  /** Seconds. */
  idleTimeout = 20 * 60;
  /** Seconds. */
  searchTimeout = 60;
  searchStartedAt: number | null = null;

  setStatus(status: BotStatus): void {
    this.status = status;
    this.searchStartedAt = status === "searching" ? now() : null;
  }

  setSearchTerm(term: string | null): void {
    this.searchTerm = term;
  }

  setDownloadProgress(filename: string, received: number, total: number): void {
    this.downloadProgress = { filename, received, total };
  }

  clearDownloadProgress(): void {
    this.downloadProgress = { filename: "", received: 0, total: 0 };
  }

  setExtractedLines(lines: string[] | null): void {
    this.extractedLines = lines;
  }

  addFile(name: string): void {
    this.files.push(name);
  }

  setError(error: string | null): void {
    this.error = error;
  }

  clearError(): void {
    this.error = null;
  }

  touchActivity(): void {
    this.lastActivity = now();
  }

  isIdle(): boolean {
    return now() - this.lastActivity > this.idleTimeout;
  }

  isSearchTimedOut(): boolean {
    if (this.status !== "searching" || this.searchStartedAt === null) return false;
    return now() - this.searchStartedAt > this.searchTimeout;
  }

  toJSON() {
    return {
      status: this.status,
      search_term: this.searchTerm,
      download_progress: { ...this.downloadProgress },
      extracted_lines: this.extractedLines,
      files: this.files,
      error: this.error,
      idle_timeout: this.idleTimeout,
      search_timeout: this.searchTimeout,
    };
  }
}

export function listDownloadedFiles(filesDir: string): string[] {
  if (!existsSync(filesDir)) return [];
  return readdirSync(filesDir)
    .filter((name) => {
      try {
        return statSync(join(filesDir, name)).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

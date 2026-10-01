/**
 * Background job contract (invariant 5 and 6).
 *
 * Every shell command is a job from the moment it starts: a foreground command
 * that outlives its deadline keeps running and the caller switches to polling
 * it by id, and a cancelled turn kills what it started instead of leaking a
 * process.
 */

export type JobStatus = 'running' | 'exited' | 'failed' | 'killed';

export interface JobSnapshot {
  readonly id: string;
  readonly command: string;
  readonly cwd: string;
  readonly pid: number | undefined;
  readonly status: JobStatus;
  readonly startedAt: number;
  readonly endedAt: number | undefined;
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** Characters produced in total, including output the ring buffer dropped. */
  readonly outputChars: number;
  /** Characters dropped from the head of the buffer to stay bounded. */
  readonly droppedChars: number;
  readonly error: string | undefined;
}

export interface JobOutput {
  readonly snapshot: JobSnapshot;
  readonly text: string;
  /** Cursor to pass as `since` on the next read. */
  readonly nextCursor: number;
  /** True when output before the requested cursor was already dropped. */
  readonly lossy: boolean;
}

export interface JobWaitOptions {
  /** 0 or undefined waits indefinitely. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface JobWaitResult {
  /** `settled` means the process ended; `running` means the deadline fired first. */
  readonly outcome: 'settled' | 'running' | 'cancelled';
  readonly snapshot: JobSnapshot;
}

export interface JobNotice {
  readonly jobId: string;
  readonly command: string;
  readonly status: JobStatus;
  readonly exitCode: number | null;
  readonly signal: string | null;
}

export interface JobSpawnOptions {
  readonly cwd: string;
}

export interface JobRegistry {
  spawn(command: string, options: JobSpawnOptions): Promise<{ readonly jobId: string }>;
  /** Terminates the job's whole process group and settles after it stops. */
  kill(jobId: string): Promise<void>;
  list(): readonly string[];
  snapshot(jobId: string): JobSnapshot | undefined;
  read(jobId: string, options?: { readonly since?: number }): JobOutput | undefined;
  wait(jobId: string, options?: JobWaitOptions): Promise<JobWaitResult>;
  /** Completion notices accumulated since the last drain. */
  drainNotices(): readonly JobNotice[];
}

export type RoutineSchedule =
  | { type: "once"; at: number }
  | { type: "daily"; time: string; weekdays: number[] };

export type RoutineRunOn = "agent" | "cloud" | "opensandbox";

export type RoutineRunTrigger = "schedule" | "manual" | "webhook";

export type RoutineRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "missed";

export interface Routine {
  id: string;
  name: string;
  prompt: string;
  botId: string;
  runOn: RoutineRunOn;
  enabled: boolean;
  schedule: RoutineSchedule;
  durationMinutes: number;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
  /** Watcher mode: notify only when the watched state changes. */
  sentry?: boolean;
  /** Last digest the sentry saw (server-side diff memory). */
  lastDigest?: string | null;
  /** Overnight mode: total consecutive runs per firing. */
  iterations?: number;
  /** Shared cross-iteration memory file the bot reads and appends to. */
  notesFile?: string;
}

export interface RoutineRun {
  id: string;
  routineId: string;
  routineName: string;
  prompt?: string;
  durationMinutes?: number;
  botId: string;
  runOn: RoutineRunOn;
  scheduledFor: number;
  status: RoutineRunStatus;
  manual: boolean;
  triggerSource?: RoutineRunTrigger;
  webhookId?: string;
  deliveryId?: string;
  threadId?: string;
  startedAt?: number;
  finishedAt?: number;
  output?: string;
  error?: string;
  cost?: number | null;
  denials?: string[];
  createdAt: number;
  seenAt?: number;
  /** Sentry runs only: true when this run's watch changed (or failed). */
  changeDetected?: boolean;
  /** Overnight chain position (1..iterations); absent on single runs. */
  iteration?: number;
}

export interface RoutineInput {
  name: string;
  prompt: string;
  botId: string;
  runOn?: RoutineRunOn;
  enabled?: boolean;
  schedule: RoutineSchedule;
  durationMinutes?: number;
  /** Watcher mode: notify only when the watched state changes. */
  sentry?: boolean;
  /** Overnight mode: consecutive runs per firing (2-12). */
  iterations?: number;
  /** Shared cross-iteration memory file. */
  notesFile?: string;
}

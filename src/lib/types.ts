/** "pulse" is never user-selectable — it's the mode /api/pulse runs under. */
export type ModeId = "brainstorming" | "authoring" | "critique" | "pulse";

export interface Assistant {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  /**
   * This assistant's own knowledge directory — browsed in the Knowledge tab and
   * the only place it may write. Falls back to settings.knowledgeRoot if unset.
   */
  knowledgeRoot?: string;
  /**
   * Extra directories this assistant may READ (never write). Falls back to
   * settings.knowledgeDirs if unset. Use [] to give it nothing but its own root.
   */
  readableDirs?: string[];
  createdAt: number;
}

export interface Thread {
  id: string;
  assistantId: string;
  title: string;
  /** Claude CLI session id — this is what gives the thread its memory. */
  sessionId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  content: string;
  mode: ModeId | null;
  costUsd: number | null;
  createdAt: number;
}

/**
 * Clarifying questions the assistant raised. They queue here instead of
 * interrupting the conversation.
 */
export interface Question {
  id: string;
  assistantId: string;
  threadId: string | null;
  text: string;
  /** What the user replied. Kept so the assumption and its correction stay together. */
  answer?: string;
  answered: boolean;
  createdAt: number;
  answeredAt?: number;
}

/**
 * One staleness sweep. This is an event log, not current state — the counts are
 * what the scan saw at `createdAt` and are never refreshed. Live staleness is
 * always re-derived from disk by scanRoot(); never read it from here.
 */
export interface Sweep {
  id: string;
  assistantId: string;
  createdAt: number;
  /** The model's prose digest of the scan. */
  digest: string;
  counts: {
    open: number;
    overdue: number;
    cold: number;
    stale: number;
    aging: number;
    fresh: number;
  };
  costUsd: number | null;
}

export interface Settings {
  /** Directories the assistant may read. Passed to the CLI as --add-dir. */
  knowledgeDirs: string[];
  /** Directory the Knowledge tab browses. */
  knowledgeRoot: string;
}

export interface Store {
  assistants: Assistant[];
  threads: Thread[];
  messages: Message[];
  questions: Question[];
  sweeps: Sweep[];
  settings: Settings;
}

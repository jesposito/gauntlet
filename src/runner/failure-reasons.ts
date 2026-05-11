export enum FailureReason {
  NAVIGATION_TIMEOUT = "navigation_timeout",
  HTTP_ERROR = "http_error",
  CONSOLE_ERROR = "console_error",
  UNCAUGHT_EXCEPTION = "uncaught_exception",
  NETWORK_FAILURE = "network_failure",
  ACCESSIBILITY_VIOLATION = "accessibility_violation",
  STUCK_NO_PROGRESS = "stuck_no_progress",
  ABANDONED_BY_PERSONA = "abandoned_by_persona",
  GOAL_UNREACHABLE = "goal_unreachable",
  LAYOUT_BROKEN = "layout_broken",
  KEYBOARD_TRAP = "keyboard_trap",
  UNKNOWN = "unknown",
}

export interface FailureEvent {
  reason: FailureReason;
  message: string;
  timestamp: number;
  stepIndex: number;
  url: string;
  metadata?: Record<string, unknown>;
}

// Error codes surfaced to users. Messages must be actionable and must never
// include typed values or other sensitive data.

export type ErrorCode =
  | 'ELEMENT_NOT_FOUND'
  | 'ELEMENT_NOT_VISIBLE'
  | 'ELEMENT_DISABLED'
  | 'ELEMENT_WRONG_TYPE'
  | 'OPTION_NOT_FOUND'
  | 'VERIFICATION_FAILED'
  | 'TIMEOUT'
  | 'NAVIGATION_FAILED'
  | 'TAB_CLOSED'
  | 'PERMISSION_DENIED'
  | 'RESTRICTED_PAGE'
  | 'INVALID_SELECTOR'
  | 'INVALID_URL'
  | 'MISSING_VARIABLE'
  | 'USER_CANCELLED'
  | 'STOPPED_BY_STEP'
  | 'STOPPED'
  | 'SCREENSHOT_FAILED'
  | 'CLIPBOARD_FAILED'
  | 'INVALID_WORKFLOW'
  | 'INVALID_VALUE'
  | 'LIMIT_EXCEEDED'
  | 'UNKNOWN';

export class FlowError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    /** Retrying cannot help (e.g. invalid selector, user cancelled). */
    public readonly fatal = false,
  ) {
    super(message);
    this.name = 'FlowError';
  }
}

export function toFlowError(err: unknown): FlowError {
  if (err instanceof FlowError) return err;
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    const e = err as { code: ErrorCode; message: string; fatal?: boolean };
    return new FlowError(e.code, e.message, !!e.fatal);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new FlowError('UNKNOWN', message || 'Unexpected error');
}

/** Plain-object form, safe to send over chrome messaging. */
export interface SerializedError {
  code: ErrorCode;
  message: string;
  fatal?: boolean;
}

export function serializeError(err: unknown): SerializedError {
  const e = toFlowError(err);
  return { code: e.code, message: e.message, fatal: e.fatal || undefined };
}

type BackendErrorCategory =
  | "Conflict"
  | "Forbidden"
  | "NotFound"
  | "Unauthenticated"
  | "RateLimited"
  | "Unsupported"
  | "Unknown";

export class BackendError extends Error {
  readonly category: BackendErrorCategory;
  readonly operation: string;
  readonly status?: number;
  readonly code?: string;
  readonly cause?: unknown;

  constructor(args: {
    category: BackendErrorCategory;
    operation: string;
    message: string;
    status?: number;
    code?: string;
    cause?: unknown;
  }) {
    super(args.message);
    this.name = "BackendError";
    this.category = args.category;
    this.operation = args.operation;
    this.status = args.status;
    this.code = args.code;
    this.cause = args.cause;
  }
}


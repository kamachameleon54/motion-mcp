export class MotionError extends Error {
  constructor(
    public code: string,
    message: string,
    public details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'MotionError';
  }
}
export function safeError(error: unknown) {
  if (error instanceof MotionError)
    return { code: error.code, message: error.message, ...error.details };
  return {
    code: 'internal_error',
    message: 'Operation failed. No credentials or upstream response bodies are exposed.',
  };
}

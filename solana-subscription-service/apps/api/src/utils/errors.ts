export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code = "APP_ERROR"
  ) {
    super(message);
  }
}

export function assertFound<T>(value: T | null | undefined, message = "Resource not found"): T {
  if (!value) {
    throw new AppError(404, message, "NOT_FOUND");
  }
  return value;
}

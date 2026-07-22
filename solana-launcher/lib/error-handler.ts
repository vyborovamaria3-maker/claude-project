/**
 * Error handling utilities for consistent and secure error responses
 * Prevents information leakage in production environments
 */

const isDev = process.env.NODE_ENV === "development";

/**
 * Sanitize error message for production
 * Returns detailed messages only in development, generic messages in production
 */
export function sanitizeErrorMessage(
  error: unknown,
  fallbackMessage: string = "An unexpected error occurred"
): string {
  if (isDev) {
    // In development, return full error details for debugging
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === "string") {
      return error;
    }
    return fallbackMessage;
  }

  // In production, never expose internal error details
  // Log the actual error server-side for investigation
  console.error("[Production Error]", error);
  return fallbackMessage;
}

/**
 * Create a standardized API error response
 */
export function createErrorResponse(
  error: unknown,
  statusCode: number = 500,
  fallbackMessage: string = "Internal server error",
  extraFields?: Record<string, unknown>
): Response {
  const message = sanitizeErrorMessage(error, fallbackMessage);
  
  const body: Record<string, unknown> = {
    error: message,
    status: statusCode,
    ...extraFields,
  };

  // Include stack trace only in development
  if (isDev && error instanceof Error && error.stack) {
    body.stack = error.stack;
  }

  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

/**
 * Safe JSON parse with error handling
 */
export function safeJsonParse(
  text: string,
  fallback: unknown = null
): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    console.error("[safeJsonParse] Failed to parse JSON:", error);
    return fallback;
  }
}

/**
 * Validate that a string doesn't contain potentially dangerous patterns
 * Used for sanitizing user inputs that might be reflected in error messages
 */
export function containsDangerousPattern(input: string): boolean {
  const dangerousPatterns = [
    /<script/i,
    /javascript:/i,
    /on\w+\s*=/i, // onclick=, onerror=, etc.
    /data:\s*text\/html/i,
    /<iframe/i,
    /<object/i,
    /<embed/i,
  ];

  return dangerousPatterns.some((pattern) => pattern.test(input));
}

/**
 * Sanitize user input for safe display
 */
export function sanitizeInput(input: string): string {
  // Remove or escape potentially dangerous characters
  return input
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;")
    .replace(/&/g, "&amp;")
    .slice(0, 1000); // Limit length to prevent DoS
}

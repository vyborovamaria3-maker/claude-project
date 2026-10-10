export interface ExternalAPIRequest {
  operation: string;
  input: unknown;
}

export interface ExternalAPIResponse {
  success: boolean;
  result?: unknown;
  error?: string;
}

export async function handleExternalRequest(request: ExternalAPIRequest): Promise<ExternalAPIResponse> {
  if (!request.operation) {
    return { success: false, error: 'missing_operation' };
  }

  return {
    success: true,
    result: request.input,
  };
}

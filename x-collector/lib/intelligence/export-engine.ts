export type ExportFormat = 'json' | 'csv';

export interface IntelligenceExportRequest {
  entityIds: string[];
  format: ExportFormat;
  includeEvidence?: boolean;
}

export interface IntelligenceExportResult {
  format: ExportFormat;
  generatedAt: string;
  data: unknown[];
}

export function createExportResult(request: IntelligenceExportRequest, data: unknown[]): IntelligenceExportResult {
  return {
    format: request.format,
    generatedAt: new Date().toISOString(),
    data,
  };
}

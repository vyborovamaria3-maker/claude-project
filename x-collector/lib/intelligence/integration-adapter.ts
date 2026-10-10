export interface IntegrationPayload {
  source: string;
  entityId: string;
  payload: unknown;
}

export interface IntegrationAdapter {
  name: string;
  transform(input: IntegrationPayload): unknown;
}

export function createAdapter(name: string, transform: (input: IntegrationPayload) => unknown): IntegrationAdapter {
  return { name, transform };
}

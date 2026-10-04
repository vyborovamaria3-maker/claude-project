import { RawMember, FilterConfig, DEFAULT_FILTER_CONFIG, scoreActivity, filterMembers } from "./tginvite-filter";

interface WorkerRequest {
  id: string;
  type: "parse" | "filter" | "score";
  payload: unknown;
}

interface WorkerResponse {
  id: string;
  type: string;
  result: unknown;
  error?: string;
}

function handleParse(members: RawMember[]) {
  const scores = members.map((m) => scoreActivity(m));
  return { members, scores };
}

function handleFilter(members: RawMember[], config?: FilterConfig) {
  return filterMembers(members, config ?? DEFAULT_FILTER_CONFIG);
}

function handleScore(members: RawMember[]) {
  return members.map((m) => scoreActivity(m));
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { id, type, payload } = event.data;
  try {
    let result: unknown;
    switch (type) {
      case "parse":
        result = handleParse(payload as RawMember[]);
        break;
      case "filter": {
        const data = payload as { members: RawMember[]; config?: FilterConfig };
        result = handleFilter(data.members, data.config);
        break;
      }
      case "score":
        result = handleScore(payload as RawMember[]);
        break;
      default:
        throw new Error(`Unknown task type: ${type}`);
    }
    const response: WorkerResponse = { id, type, result };
    self.postMessage(response);
  } catch (err: unknown) {
    const response: WorkerResponse = { id, type, result: null, error: (err as Error).message };
    self.postMessage(response);
  }
};

import { QueryClient } from "@/lib/react-query";

export function createAppQueryClient() {
  return new QueryClient();
}

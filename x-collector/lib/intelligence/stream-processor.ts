import type { IntelligenceEvent } from './event-stream';
import { analyzeRealtimeEvent } from './realtime-analyzer';

export class IntelligenceStreamProcessor {
  process(event: IntelligenceEvent) {
    return analyzeRealtimeEvent(event);
  }
}

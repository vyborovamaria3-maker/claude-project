import { buildIntelligenceProfile, type IntelligenceProfile } from './api-integration';

export class IntelligenceProfileService {
  async create(entityId: string, data: Partial<IntelligenceProfile>) {
    return buildIntelligenceProfile({
      entityId,
      ...data,
    });
  }
}

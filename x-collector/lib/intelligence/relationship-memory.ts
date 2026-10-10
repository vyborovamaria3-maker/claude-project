export interface RelationshipMemory {
  from: string;
  to: string;
  relation: string;
  confidence: number;
  evidence: unknown[];
}

export class RelationshipMemoryStore {
  private relations: RelationshipMemory[] = [];

  add(relation: RelationshipMemory) {
    this.relations.push(relation);
    return relation;
  }

  find(entityId: string) {
    return this.relations.filter(
      (relation) => relation.from === entityId || relation.to === entityId,
    );
  }
}

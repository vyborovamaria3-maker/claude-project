export type EntityImportanceInput = {
  influence?: number;
  risk?: number;
  connectivity?: number;
};

export function calculateEntityImportance(input: EntityImportanceInput) {
  return {
    score:
      (input.influence ?? 0) * 0.4 +
      (input.risk ?? 0) * 0.3 +
      (input.connectivity ?? 0) * 0.3,
  };
}

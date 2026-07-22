export type StepProps = {
  data: Record<string, any>;
  update: (patch: Record<string, any>) => void;
  next: () => void;
  prev: () => void;
};

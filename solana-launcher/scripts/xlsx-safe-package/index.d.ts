export interface CellObject {
  v?: string | number | boolean | null;
  w?: string;
  t?: string;
}

export interface WorkSheet {
  [cell: string]: CellObject | string | undefined;
  "!ref"?: string;
}

export interface WorkBook {
  SheetNames: string[];
  Sheets: Record<string, WorkSheet>;
}

export function readFile(filePath: string, options?: Record<string, unknown>): WorkBook;

export const utils: {
  encode_cell(position: { r: number; c: number }): string;
  decode_range(range: string): {
    s: { r: number; c: number };
    e: { r: number; c: number };
  };
};

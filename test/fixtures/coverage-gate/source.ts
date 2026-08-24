export function classify(value: boolean): "covered" | "uncovered" {
  if (value) return "covered";
  return "uncovered";
}

export function neverCalled(): string {
  return "uncovered";
}

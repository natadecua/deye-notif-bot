// Display only; measurements and thresholds remain in watts internally.
export function kilowatts(watts: number): string {
  if (watts > 0 && watts < 1) return '<0.001 kW';
  return `${Number((watts / 1000).toFixed(3))} kW`;
}

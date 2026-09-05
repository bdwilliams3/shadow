export function applyDiscount(total: number, percentage: number): number {
  return total * (1 - percentage / 100);
}

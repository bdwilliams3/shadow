export type HealthStatus = "ok" | "failed";

export function isAvailable(status: HealthStatus): boolean {
  return status === "ok";
}

export interface TokenEstimator {
  estimate(value: string): number;
}

export class Utf8TokenEstimator implements TokenEstimator {
  constructor(private readonly safetyMargin = 0.1) {}

  estimate(value: string): number {
    const baseline = Math.ceil(Buffer.byteLength(value, "utf8") / 4);
    return Math.ceil(baseline * (1 + this.safetyMargin));
  }
}

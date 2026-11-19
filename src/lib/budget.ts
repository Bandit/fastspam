/**
 * Subrequest accounting. Workers Free allows 50 subrequests per invocation and
 * KV operations count; whether Workers AI binding calls count is undocumented,
 * so they are counted too.
 */
export class BudgetExceededError extends Error {
  constructor(limit: number) {
    super(`ran out of subrequest budget (${limit}); lower SPAM_SLICE or BATCH_SIZE, or raise SUBREQUEST_BUDGET on Workers Paid`);
  }
}

export class Budget {
  used = 0;
  readonly limit: number;
  // No parameter properties anywhere in src/: scripts run it with Node's type stripping.
  constructor(limit: number) {
    this.limit = limit;
  }

  take(n = 1): void {
    if (this.used + n > this.limit) throw new BudgetExceededError(this.limit);
    this.used += n;
  }

  /** Count without enforcing: for the final state writes, after the digest is already out. */
  charge(n = 1): void {
    this.used += n;
  }

  get remaining(): number {
    return this.limit - this.used;
  }
}

/** Single-tab demo coordination only; real concurrency requires database transactions. */
export class DemoMutationGuard {
  private active: symbol | null = null;

  begin(): symbol | null {
    if (this.active !== null) return null;
    this.active = Symbol('demo mutation');
    return this.active;
  }

  isCurrent(token: symbol): boolean {
    return this.active === token;
  }

  finish(token: symbol): boolean {
    if (!this.isCurrent(token)) return false;
    this.active = null;
    return true;
  }

  invalidate(): void {
    this.active = null;
  }
}

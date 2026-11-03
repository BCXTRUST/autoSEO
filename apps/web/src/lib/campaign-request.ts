type ActiveRequest = {
  routeId: string;
  signal: AbortSignal;
  promise: Promise<void>;
};

/** Serializes refreshes for one campaign and gives each route its own abort scope. */
export class CampaignRequestGate {
  private route: { id: string; controller: AbortController } | null = null;
  private active: ActiveRequest | null = null;

  activate(routeId: string): AbortSignal {
    this.route?.controller.abort();
    const controller = new AbortController();
    this.route = { id: routeId, controller };
    return controller.signal;
  }

  deactivate(routeId: string, signal: AbortSignal) {
    if (this.route?.id !== routeId || this.route.controller.signal !== signal) return;
    this.route.controller.abort();
    this.route = null;
  }

  run(
    routeId: string,
    signal: AbortSignal,
    work: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    if (signal.aborted || this.route?.id !== routeId || this.route.controller.signal !== signal) {
      return Promise.resolve();
    }
    const active = this.active;
    if (active?.routeId === routeId && active.signal === signal) {
      return active.promise.then(
        () => this.run(routeId, signal, work),
        () => this.run(routeId, signal, work),
      );
    }
    const promise = Promise.resolve()
      .then(() => work(signal))
      .finally(() => {
        if (this.active?.promise === promise) this.active = null;
      });
    this.active = { routeId, signal, promise };
    return promise;
  }
}

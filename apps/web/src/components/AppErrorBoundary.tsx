import { Component, type ErrorInfo, type ReactNode } from "react";

interface State {
  failed: boolean;
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { failed: false };

  constructor(props: { children: ReactNode } = { children: null }) {
    super(props);
  }

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo) {
    // Keep the fallback generic; implementation details belong in diagnostics.
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="grid min-h-full place-items-center bg-[#090a0e] px-6 text-center text-[#c8d0dc]">
        <section className="max-w-md">
          <div className="mb-3 text-xs font-medium uppercase tracking-[0.18em] text-[#70cbc5]">
            AutoSEO
          </div>
          <h1 className="text-xl font-semibold text-[#edf1f6]">This page hit a snag</h1>
          <p className="mt-2 text-sm leading-6 text-[#929dac]">
            Your saved campaign data is safe. Reload the page or return to your campaigns.
          </p>
          <div className="mt-5 flex justify-center gap-3">
            <button
              className="rounded-md border border-[#39414e] px-4 py-2 text-sm hover:bg-[#171b23] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#70cbc5]"
              onClick={() => window.location.reload()}
              type="button"
            >
              Reload page
            </button>
            <a
              className="rounded-md bg-[#70cbc5] px-4 py-2 text-sm font-medium text-[#0a1115] hover:bg-[#8bddda] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#70cbc5]"
              href="/app"
            >
              Back to campaigns
            </a>
          </div>
        </section>
      </main>
    );
  }
}

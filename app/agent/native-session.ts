import { DiagnosticClient } from "../scripts/diagnostic-client";

export type IntentCursor = { revision: number; element_id: string; point: { x: number; y: number } };
export type NativeStatus = {
  session: number; phase: "initializing" | "active" | "paused" | "stopped"; reason: string;
  hwnd: number; cursor: IntentCursor | null; actions: number; inspection_required: boolean;
  physical_cursor: { x: number; y: number } | null; foreground_hwnd: number;
  last_backend: string | null;
  verification_pending: boolean; last_outcome: string | null;
};
export type Transport = { request(command: Record<string, unknown>): Promise<any>; close(): Promise<void> };

export class NativeSession {
  private constructor(private readonly transport: Transport, readonly id: number) {}
  static async open(hwnd: number, enableActions = false, transport: Transport = new DiagnosticClient("kaji-assist", enableActions ? ["--enable-actions"] : [])) {
    if (!Number.isSafeInteger(hwnd) || hwnd <= 0) { await transport.close(); throw new Error("A current target HWND is required"); }
    try {
      const status: NativeStatus = await transport.request({ command: "begin", hwnd });
      return new NativeSession(transport, status.session);
    } catch (error) { await transport.close(); throw error; }
  }
  async request<T = any>(command: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    let remove = () => {};
    let cancellation: Promise<unknown> | undefined;
    const aborted = new Promise<never>((_, reject) => {
      if (!signal) return;
      const onAbort = () => {
        // Await native cancellation so a rejected JS promise cannot leave an action running.
        cancellation = this.transport.request({ command: "pause" }).catch(() => this.transport.request({ command: "stop" }));
        void cancellation.then(() => reject(signal.reason ?? new Error("Cancelled")), reject);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      remove = () => signal.removeEventListener("abort", onAbort);
    });
    try {
      const result = await Promise.race([this.transport.request({ ...args, command, session: this.id }), aborted]);
      if (cancellation) await cancellation;
      signal?.throwIfAborted();
      return result;
    } finally { if (cancellation) await cancellation; remove(); }
  }
  status(): Promise<NativeStatus> { return this.transport.request({ command: "status" }); }
  pause(): Promise<NativeStatus> { return this.transport.request({ command: "pause" }); }
  resume(): Promise<NativeStatus> { return this.transport.request({ command: "resume", session: this.id }); }
  stop(): Promise<NativeStatus> { return this.transport.request({ command: "stop" }); }
  close() { return this.transport.close(); }
}

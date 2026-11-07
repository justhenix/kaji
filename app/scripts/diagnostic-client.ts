import { resolve } from "node:path";
import { nativeTargetDir } from './native-output';

export class DiagnosticClient {
  readonly process;
  private id = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  readonly stderr: Promise<string>;
  constructor(binary = "kaji-diag", args: string[] = []) {
    this.process = Bun.spawn([resolve(nativeTargetDir, `debug/${binary}.exe`), ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
    this.stderr = new Response(this.process.stderr).text();
    void this.read();
  }
  private async read() {
    let buffer = "";
    const decoder = new TextDecoder();
    try {
      for await (const chunk of this.process.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        let index: number;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          if (!line.trim()) continue;
          const response = JSON.parse(line);
          const pending = this.pending.get(response.id);
          if (!pending) continue;
          clearTimeout(pending.timer); this.pending.delete(response.id);
          if ("Err" in response.result) pending.reject(new Error(response.result.Err));
          else pending.resolve(response.result.Ok);
        }
      }
    } catch (error) { console.error(error); }
    finally {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("diagnostic process exited")); }
      this.pending.clear();
    }
  }
  request(command: Record<string, unknown>): Promise<any> {
    if (this.process.exitCode !== null) return Promise.reject(new Error("diagnostic process exited"));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("diagnostic request timed out")); }, 8000);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(JSON.stringify({ ...command, id }) + "\n");
      this.process.stdin.flush();
    });
  }
  async close() {
    if (this.process.exitCode !== null) return;
    try { await this.request({ command: "shutdown" }); } finally { this.process.stdin.end(); await this.process.exited; }
  }
}

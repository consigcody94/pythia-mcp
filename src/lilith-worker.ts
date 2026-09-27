import { spawn, type ChildProcessWithoutNullStreams } from "child_process";

export interface LilithWorkerResult {
  likelihood: number;
  ndf: number;
  dbVersion: string;
  durationMs: number;
  cachedDatabase: boolean;
}

interface WorkerResponse {
  id?: string;
  ok?: boolean;
  result?: LilithWorkerResult;
  error?: string;
}

interface PendingRequest {
  resolve: (result: LilithWorkerResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const WORKER_TIMEOUT_MS = 60000;

class LilithWorkerClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private sequence = 0;
  private pending = new Map<string, PendingRequest>();
  private startPromise: Promise<void> | null = null;

  constructor(
    private readonly lilithDirectory: string,
    private readonly pythonCommand: string,
  ) {}

  async request(inputXml: string, expInput: string): Promise<LilithWorkerResult> {
    await this.start();
    if (!this.process?.stdin || this.process.killed) {
      throw new Error("Lilith worker is not running");
    }

    const id = `${process.pid}-${Date.now()}-${this.sequence++}`;
    return new Promise<LilithWorkerResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.restart(new Error("Lilith worker timed out"));
        reject(new Error("Lilith worker timed out after 60 seconds"));
      }, WORKER_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.process?.stdin.write(`${JSON.stringify({ id, inputXml, expInput })}\n`, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  close(): void {
    this.restart(new Error("Lilith worker closed"));
  }

  private async start(): Promise<void> {
    if (this.process && !this.process.killed) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise<void>((resolve, reject) => {
      const child = spawn(this.pythonCommand, ["pythia_worker.py"], {
        cwd: this.lilithDirectory,
        env: { ...process.env, PYTHONPATH: this.lilithDirectory },
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.process = child;
      this.buffer = "";

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => this.consume(chunk));
      child.stderr.on("data", () => {
        // Worker diagnostics must never corrupt the JSON-lines stdout protocol.
      });
      child.once("error", (error) => {
        this.failAll(error instanceof Error ? error : new Error(String(error)));
        reject(error instanceof Error ? error : new Error(String(error)));
      });
      child.once("exit", (code, signal) => {
        const detail = `Lilith worker exited${code === null ? ` by ${signal ?? "unknown signal"}` : ` with code ${code}`}`;
        this.failAll(new Error(detail));
        this.process = null;
      });
      resolve();
    }).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let response: WorkerResponse;
      try {
        response = JSON.parse(line) as WorkerResponse;
      } catch {
        this.failAll(new Error("Lilith worker returned invalid JSON"));
        continue;
      }
      if (!response.id) continue;
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.ok && response.result) pending.resolve(response.result);
      else pending.reject(new Error(response.error || "Lilith worker request failed"));
    }
  }

  private restart(reason: Error): void {
    this.failAll(reason);
    if (this.process && !this.process.killed) this.process.kill();
    this.process = null;
    this.buffer = "";
  }

  private failAll(reason: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(reason);
      this.pending.delete(id);
    }
  }
}

export class LilithWorkerPool {
  private readonly clients: LilithWorkerClient[];
  private nextClient = 0;

  constructor(
    lilithDirectory: string,
    pythonCommand: string,
    workerCount = 2,
  ) {
    const count = Math.min(Math.max(Math.floor(workerCount), 1), 8);
    this.clients = Array.from({ length: count }, () => new LilithWorkerClient(lilithDirectory, pythonCommand));
  }

  get size(): number {
    return this.clients.length;
  }

  request(inputXml: string, expInput = "data/latest.list"): Promise<LilithWorkerResult> {
    const client = this.clients[this.nextClient++ % this.clients.length];
    return client.request(inputXml, expInput);
  }

  close(): void {
    for (const client of this.clients) client.close();
  }
}

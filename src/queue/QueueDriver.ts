export interface JobRecord {
  id: number;
  queue: string;
  jobClass: string;
  payload: string;
  attempts: number;
  maxAttempts: number;
  availableAt: number;
  reservedAt: number | null;
  createdAt: number;
}

export interface QueueDriver {
  migrate(): Promise<void>;
  dispatch(queue: string, jobClass: string, payload: string, delaySeconds: number, maxAttempts: number): Promise<void>;
  reserve(queue: string, retryAfterSeconds: number): Promise<JobRecord | null>;
  complete(id: number): Promise<void>;
  fail(id: number, exception: string): Promise<void>;
  release(id: number, delaySeconds: number): Promise<void>;
  size(queue?: string): Promise<number>;
}

export interface RuntimeOptions {
  directory?: string;
  /** Defaults to 4318. Use 0 for an OS-assigned loopback port. */
  port?: number;
  /** A clock in epoch milliseconds, useful for deterministic harnesses. */
  now?: () => number;
}

export interface RuntimeHost {
  readonly url: string;
  readonly certificate: string;
  /** Owner-only metadata. Do not give this handle to a worker. */
  readonly store: {
    readonly directory: string;
    readonly keyFingerprint: string;
    readonly identity: {
      readonly runtimeId: string;
      readonly token: string;
      readonly publicKey: string;
    };
  };
  close(): Promise<void>;
}

export function createRuntime(options?: RuntimeOptions): Promise<RuntimeHost>;

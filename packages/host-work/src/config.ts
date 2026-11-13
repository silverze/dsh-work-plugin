/** Runtime configuration for host-work. All fields are optional. */
export interface Config {
  /** Absolute artifact root. Defaults to `$DSH_HOME/work/artifacts`. */
  artifactRoot?: string
  /** Keep at most this many artifact versions per file. */
  maxVersionsPerArtifact?: number
  /** Default model for new work tasks. */
  defaultModel?: string
  /** Automatic retries for a failed scheduled run (default 1). */
  maxScheduleRetries?: number
  /** Delay before a scheduled retry (default 5000 ms). */
  retryDelayMs?: number
  /** Register the work/* Remote namespace (default true; tests disable it). */
  remote?: boolean
  /** Screen-presence tools and the composer chip, macOS only (default true). */
  presence?: boolean
}

export const DEFAULT_CONFIG: Required<Pick<Config, 'maxVersionsPerArtifact'>> = {
  maxVersionsPerArtifact: 10,
}

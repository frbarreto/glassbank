/** Thrown by `loadConfig` with one line per missing or malformed environment variable. */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    const lines = problems.map((problem) => `  - ${problem}`).join('\n');
    super(
      `Invalid environment configuration (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n${lines}\n` +
        'See .env.example and docs/DEPLOYMENT.md section 3 for every variable and its default.',
    );
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/**
 * Raised when configuration fails validation.
 *
 * The message carries variable names and validation messages only. Values are
 * never interpolated, because this error is allowed to reach logs and crash
 * output while the variables it describes are secrets.
 */
export class InvalidEnvironmentError extends Error {
  readonly variableNames: readonly string[];

  constructor(problems: readonly string[], variableNames: readonly string[]) {
    super(`Invalid environment configuration:\n- ${problems.join("\n- ")}`);
    this.name = "InvalidEnvironmentError";
    this.variableNames = variableNames;
  }
}

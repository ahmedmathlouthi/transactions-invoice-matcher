/**
 * Errors the job knows how to report. Anything else (driver errors, bugs) is
 * unexpected: it propagates, the write is rolled back and the process exits 1.
 */
export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly exitCode: number;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Bad input from the caller (e.g. a malformed SIREN). */
export class InvalidInputError extends AppError {
  readonly code = 'invalid_input';
  readonly exitCode = 2;
}

export class CompanyNotFoundError extends AppError {
  readonly code = 'company_not_found';
  readonly exitCode = 2;

  constructor(readonly siren: string) {
    super(`No company with SIREN ${siren}`);
  }
}

/**
 * One record can't be interpreted (e.g. an unparsable amount). Caught per
 * record and turned into an `invalid_data` decision: it never aborts the run.
 */
export class InvalidDataError extends AppError {
  readonly code = 'invalid_data';
  readonly exitCode = 1;
}

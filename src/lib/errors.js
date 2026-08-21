'use strict';

/** Base class for errors that are safe to surface to a client verbatim. */
class AppError extends Error {
  constructor(message, status = 500, code = 'internal_error', details = undefined) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    this.details = details;
    this.expected = true;
  }
}

class BadRequestError extends AppError {
  constructor(message = 'Bad request', details) {
    super(message, 400, 'bad_request', details);
  }
}

class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401, 'unauthorized');
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(message, 404, 'not_found');
  }
}

class ConflictError extends AppError {
  constructor(message = 'Already exists') {
    super(message, 409, 'conflict');
  }
}

/**
 * The play session behind an attempt token is gone - expired, evicted, or lost because the
 * process restarted (which on a sleeping free-tier host is routine).
 *
 * It gets its own code because the client can genuinely recover from it: reload the same puzzle
 * and let the player answer again. Every other 400 means "you sent something wrong".
 */
class AttemptExpiredError extends AppError {
  constructor(message = 'Your play session for this puzzle expired - load it again') {
    super(message, 400, 'attempt_expired');
  }
}

class ValidationError extends AppError {
  /** @param {Array<{path: string, message: string}>} issues */
  constructor(issues, message = 'Validation failed') {
    super(message, 422, 'validation_failed', { issues });
    this.issues = issues;
  }
}

module.exports = {
  AppError,
  AttemptExpiredError,
  BadRequestError,
  UnauthorizedError,
  NotFoundError,
  ConflictError,
  ValidationError,
};

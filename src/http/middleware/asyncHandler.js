'use strict';

/**
 * Wrap an async route handler so a rejected promise reaches the Express error middleware
 * instead of hanging the request.
 * @template {import('express').RequestHandler} T
 * @param {T} handler
 * @returns {import('express').RequestHandler}
 */
const asyncHandler = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

module.exports = { asyncHandler };

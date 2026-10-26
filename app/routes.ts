import { flatRoutes } from "@react-router/fs-routes";

/**
 * Route discovery via the filesystem. `flatRoutes()` returns a promise that
 * React Router awaits internally, so the default export is the promise itself
 * rather than an async wrapper — the config validator checks the *resolved*
 * value is an array, and an async function would resolve to a promise.
 *
 *   app/routes/healthz.tsx          -> /healthz
 *   app/routes/readyz.tsx           -> /readyz
 *   app/routes/webhooks.tsx         -> /webhooks
 *   app/routes/api.survey.tsx       -> /api/survey
 *   app/routes/api.survey-responses.tsx -> /api/survey-responses
 */
export default flatRoutes({ ignoredRouteFiles: ["**/.*"] });

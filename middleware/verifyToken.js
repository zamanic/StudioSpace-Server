import { createRemoteJWKSet, jwtVerify } from "jose";

export const API_AUTH_COOKIE = "studiospace_jwt";

// The public keys are published by Better Auth on the Next.js client at
// /api/auth/jwks. We cache the key set for the whole process instead of
// building a new one on every request.
let cachedJWKS = null;

function getJWKS() {
  if (!cachedJWKS) {
    //const clientUrl = process.env.CLIENT_URL || "http://localhost:3000";
    const clientUrl = process.env.CLIENT_URL;
    cachedJWKS = createRemoteJWKSet(new URL(`${clientUrl}/api/auth/jwks`));
  }
  return cachedJWKS;
}

function readCookie(header, name) {
  if (!header) return null;
  const found = String(header)
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));

  if (!found) return null;

  const value = found.slice(name.length + 1);
  return value ? decodeURIComponent(value) : null;
}

/**
 * Reusable Express middleware. Every protected route reuses this exact
 * function - never re-implemented inline per route.
 *
 * Reads the JWT from the API's HttpOnly cookie first, then falls back to
 * `authorization: Bearer <jwt>` for server-side fetches and the one-time
 * cookie-sync handshake from the Next.js client.
 */
export const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const cookieToken = readCookie(req.headers.cookie, API_AUTH_COOKIE);
  const headerToken = authHeader?.split(" ")[1];
  const token = cookieToken || headerToken;

  if (!token) {
    return res
      .status(401)
      .json({
        code: "UNAUTHORIZED",
        message: "Sign in again to continue.",
      });
  }

  try {
    const { payload } = await jwtVerify(token, getJWKS());
    // Hand the decoded user down to the route handler so it can do
    // ownership checks without trusting anything sent in the body.
    req.user = payload;
    next();
  } catch (error) {
    // An invalid or expired JWT is 401, not 500 - the client is at fault and
    // simply needs to sign in again.
    return res
      .status(401)
      .json({
        code: "INVALID_TOKEN",
        message: "Your session has expired. Please sign in again.",
      });
  }
};

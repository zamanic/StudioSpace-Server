import { createRemoteJWKSet, jwtVerify } from "jose";

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

/**
 * Reusable Express middleware. Every protected route reuses this exact
 * function - never re-implemented inline per route.
 *
 * Reads `authorization: Bearer <jwt>` produced on the client by
 * `authClient.token()` (client components) or `auth.api.getToken()`
 * (server components).
 */
export const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res
      .status(401)
      .json({ code: "UNAUTHORIZED", message: "Missing authorization header." });
  }

  const token = authHeader.split(" ")[1];

  if (!token) {
    return res
      .status(401)
      .json({ code: "UNAUTHORIZED", message: "Missing bearer token." });
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

import { Request, Response, NextFunction } from 'express';
import { jwtVerify, JWTVerifyResult } from "jose";
import { TextEncoder } from 'util';

/**
 * Interface extending Express Request to include user payload
 */
interface AuthenticatedRequest extends Request {
  user?: {
    [key: string]: any;
  };
}

/**
 * JWT Authentication Middleware
 * 
 * This middleware validates JWT tokens provided in either:
 * 1. Authorization header (Bearer token)
 * 2. Cookie (token)
 * 
 * The middleware:
 * - Extracts the token from headers or cookies
 * - Validates the token using JOSE library
 * - Verifies token signature and issuer
 * - Attaches decoded user payload to request object
 * 
 * @param {AuthenticatedRequest} req - Express request object
 * @param {Response} res - Express response object
 * @param {NextFunction} next - Express next middleware function
 * @returns {void}
 * @throws {401} If token is missing or invalid
 * 
 * @example
 * // Usage in routes
 * router.use(jwtAuthMiddleware);
 * 
 * // Protected route handler
 * router.get('/protected', (req, res) => {
 *   const user = req.user; // Access authenticated user data
 *   res.json({ message: `Hello ${user.name}` });
 * });
 */
const jwtAuthMiddleware = async (
  req: any,
  res: any,
  next: any
): Promise<Response | void> => {
  try {
    // Extract token from Authorization header or cookie
    let token: string | undefined = req.headers["authorization"] as string;

    if (token) {
      // Remove 'Bearer ' prefix if present
      token = token.split(" ")[1];
    } else {
      // Fall back to cookie if no Authorization header
      if (!req.cookies?.token) {
        return res.status(401).send("Unauthorized: No token provided");
      }
      token = req.cookies.token;
    }

    // Ensure token exists before verification
    if (!token) {
      return res.status(401).send("Unauthorized: Invalid token format");
    }

    // JWT verification configuration
    const secret = new TextEncoder().encode(
      process.env.JWT_SECRET || "akshajwt"
    );
    const alg = "HS256";

    // Verify token and extract payload
    const jwtToken: JWTVerifyResult = await jwtVerify(token, secret, {
      algorithms: [alg],
      issuer: "askha-express",
    });

    // Attach user payload to request for use in route handlers
    req.user = jwtToken.payload;

    // Continue to next middleware/route handler
    next();
  } catch (error: any) {
    console.error('JWT Authentication Error:', error);
    return res
      .status(401)
      .send(`Authentication failed: ${error?.message || "Unknown error"}`);
  }
};

export default jwtAuthMiddleware;

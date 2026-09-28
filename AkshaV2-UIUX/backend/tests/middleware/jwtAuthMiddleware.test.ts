import jwtAuthMiddleware from "../../src/middleware/jwtAuthMiddleware";
import { jwtVerify } from "jose";

jest.mock("jose");

describe("jwtAuthMiddleware", () => {
  let req: any;
  let res: any;
  let next: jest.Mock;

  beforeEach(() => {
    req = {
      headers: {},
      cookies: {},
    };
    res = {
      status: jest.fn().mockReturnThis(),
      send: jest.fn(),
    };
    next = jest.fn();
    (jwtVerify as jest.Mock).mockReset();
  });

  it("should return 401 if no token provided", async () => {
    await jwtAuthMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.send).toHaveBeenCalledWith("Unauthorized: No token provided");
    expect(next).not.toHaveBeenCalled();
  });

  it("should return 401 if token format is invalid", async () => {
    req.headers.authorization = "Bearer ";
    await jwtAuthMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.send).toHaveBeenCalledWith("Unauthorized: Invalid token format");
    expect(next).not.toHaveBeenCalled();
  });

  it("should verify token from Authorization header and call next", async () => {
    req.headers.authorization = "Bearer validtoken";
    (jwtVerify as jest.Mock).mockResolvedValue({
      payload: { user: "testuser" },
    });
    await jwtAuthMiddleware(req, res, next);
    expect(jwtVerify).toHaveBeenCalledWith(
      "validtoken",
      expect.any(Uint8Array),
      expect.objectContaining({ algorithms: ["HS256"], issuer: "askha-express" })
    );
    expect(req.user).toEqual({ user: "testuser" });
    expect(next).toHaveBeenCalled();
  });

  it("should verify token from cookie and call next", async () => {
    req.cookies.token = "cookietoken";
    (jwtVerify as jest.Mock).mockResolvedValue({
      payload: { user: "cookieuser" },
    });
    await jwtAuthMiddleware(req, res, next);
    expect(jwtVerify).toHaveBeenCalledWith(
      "cookietoken",
      expect.any(Uint8Array),
      expect.objectContaining({ algorithms: ["HS256"], issuer: "askha-express" })
    );
    expect(req.user).toEqual({ user: "cookieuser" });
    expect(next).toHaveBeenCalled();
  });

  it("should return 401 on verification error", async () => {
    req.headers.authorization = "Bearer invalidtoken";
    (jwtVerify as jest.Mock).mockRejectedValue(new Error("Invalid token"));
    await jwtAuthMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.send).toHaveBeenCalledWith("Authentication failed: Invalid token");
    expect(next).not.toHaveBeenCalled();
  });
});

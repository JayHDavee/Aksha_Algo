import request from "supertest";
import express from "express";
jest.mock("fs", () => ({
  readdir: (dir, cb) => cb(null, []),
  readFile: (file, enc, cb) => cb(null, "{}"),
  stat: (path, cb) => cb(null, { mtime: new Date() }),
  existsSync: () => true,
  mkdirSync: () => {}
}));

import alertsRouter from "../../src/routes/alerts";

const app = express();

app.use(express.json());

// Mount router exactly like in your server
app.use("/api/alerts", alertsRouter);

describe("Alerts Routes", () => {
  it("should respond to GET /api/alerts/recent-alert/1 with 200", async () => {
    const res = await request(app).get("/api/alerts/recent-alert/1");
    expect(res.status).toBe(200);
  });

  it("should return 404 for invalid routes under /api/alerts", async () => {
    const res = await request(app).get("/api/alerts/unknown");
    expect(res.status).toBe(404);
  });
});

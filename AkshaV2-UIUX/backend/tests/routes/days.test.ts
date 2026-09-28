import request from "supertest";
import express from "express";
import daysRouter from "../../src/routes/days";

// Create an isolated express app for testing
const app = express();
app.use(express.json());

// Mount the router under /api
app.use("/api", daysRouter);

describe("Days Routes", () => {

  it("should return 400 when 'workday' is missing", async () => {
    const res = await request(app).get("/api/days");
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("should return 200 when 'workday' is provided", async () => {
    const res = await request(app)
      .get("/api/days")
      .query({ workday: "monday" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("should return 404 for invalid route", async () => {
    const res = await request(app).get("/api/unknown-days");
    expect(res.status).toBe(404);
  });

});

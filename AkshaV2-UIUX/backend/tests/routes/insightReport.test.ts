import request from "supertest";
import express from "express";
import router from "../../src/routes/insightReport"; // <-- adjust path

// Setup ENV
process.env.INSIGHT_REPORT = "/insight-report";

const app = express();
app.use(express.json());
app.use("/", router);

describe("POST /insight-report", () => {
  it("should return 400 when startDate or endDate is missing", async () => {
    const res = await request(app)
      .post("/insight-report")
      .send({
        startTime: "09:00:00",
        endTime: "17:00:00",
        cameras: ["Cam1"]
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("date is missing, or in incorrect format");
  });
});

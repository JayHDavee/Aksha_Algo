import mongoose from "mongoose";
import connection from "../../src/db/connection";

describe("Database connection module", () => {
  it("should export mongoose connection", () => {
    expect(connection).toBe(mongoose.connection);
  });
});

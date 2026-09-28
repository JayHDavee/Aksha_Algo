import Alerts, { IAlert } from "../../src/models/myAlertSchema";

describe("myAlertSchema model", () => {
  it("should create a new alert document", () => {
    const alertDoc: Partial<IAlert> = {
      Alert_Name: "Test Alert",
      No_Object_Status: false,
      Object_Class: "person",
      Object_Area: [[100, 100], [200, 100], [200, 200], [100, 200]],
      Start_Time: "09:00",
      End_Time: "17:00",
      Days_Active: ["Monday", "Tuesday"],
      Holiday_Status: false,
      Workday_Status: true,
      Alert_Status: "active",
      Display_Activation: true,
      Email_Activation: true,
      Camera_Name: ["Camera1", "Camera2"],
    };
    const doc = new Alerts(alertDoc);
    expect(doc).toBeInstanceOf(Alerts);
    expect(doc.Alert_Name).toBe("Test Alert");
  });
});

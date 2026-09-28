import Resource, { INotificationResource } from "../../src/models/resourceSchema";

describe("resourceSchema model", () => {
  it("should create a new resource document", () => {
    const resourceDoc: Partial<INotificationResource> = {
      notification_email: ["admin@example.com"],
      username: "admin",
      new_email: "admin@example.com",
      bot_token: "telegram_bot_token",
      chat_ids: ["chat_id_1", "chat_id_2"],
      send_alert_report: true,
      alert_report_email: ["reports@example.com"],
      genai_features: true,
    };
    const doc = new Resource(resourceDoc);
    expect(doc).toBeInstanceOf(Resource);
    expect(doc.username).toBe("admin");
  });
});

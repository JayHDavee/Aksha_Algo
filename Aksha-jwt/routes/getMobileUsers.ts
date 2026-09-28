import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  DynamoDBClient,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";

const dbClient = new DynamoDBClient({
  region: process.env.AWS_REGION ?? "us-east-1",
});

const TABLE_NAME = "Aksha_Mobile_Users";

const getMobileUsers = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  try {
    // Get siteId from query params
    const siteId = event.queryStringParameters?.siteId;

    if (!siteId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          message: "siteId is required",
        }),
      };
    }

    // Fetch users by siteId
    const result = await dbClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: "siteId = :siteId",
        ExpressionAttributeValues: {
          ":siteId": { S: siteId },
        },
        ProjectionExpression: "email, mobile_id, username, notificationsEnabled",
      })
    );

    const users =
      result.Items?.map((item) => ({
        email:     item.email?.S     || "",
        mobile_id: item.mobile_id?.S || "",
        username:  item.username?.S  || "",
        notificationsEnabled: item.notificationsEnabled?.BOOL ?? false,
      })) || [];

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: "Users fetched successfully",
        users,
      }),
    };
  } catch (error) {
    console.error("Get Mobile Users Error:", error);

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        message: "Internal server error",
      }),
    };
  }
};

export default getMobileUsers;
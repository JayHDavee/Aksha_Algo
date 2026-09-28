import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  DynamoDBClient,
  UpdateItemCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";

const dbClient = new DynamoDBClient({
  region: process.env.AWS_REGION ?? "us-east-1",
});

const TABLE_NAME = "Aksha_Mobile_Users";

const updateMobileUser = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  try {
    const email = event.queryStringParameters?.email;

    if (!email) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          message: "email is required in query parameters",
        }),
      };
    }

    if (!event.body) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ message: "Missing request body" }),
      };
    }

    let rawBody: any;
    try {
      rawBody = JSON.parse(event.body);
    } catch {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ message: "Invalid JSON in request body" }),
      };
    }

    const { notificationsEnabled } = rawBody;

    if (notificationsEnabled === undefined) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ message: "No valid fields provided for update" }),
      };
    }

    const updateExpressions = ["#notificationsEnabled = :notificationsEnabled"];
    const expressionAttributeNames: any = { "#notificationsEnabled": "notificationsEnabled" };
    const expressionAttributeValues: any = { ":notificationsEnabled": { BOOL: notificationsEnabled } };

    const updateExpressionStr = "SET " + updateExpressions.join(", ");

    await dbClient.send(
      new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: {
          email: { S: email },
        },
        UpdateExpression: updateExpressionStr,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ConditionExpression: "attribute_exists(email)", // Ensure the user actually exists
      })
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: "User updated successfully",
      }),
    };
  } catch (error: any) {
    if (error.name === "ConditionalCheckFailedException") {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ message: "User not found" }),
      };
    }

    console.error("Update Mobile User Error:", error);

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        message: "Internal server error while updating user",
      }),
    };
  }
};

export default updateMobileUser;
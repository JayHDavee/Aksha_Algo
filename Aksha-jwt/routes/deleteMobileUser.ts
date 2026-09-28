import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { DynamoDBClient, DeleteItemCommand } from "@aws-sdk/client-dynamodb";

const dbClient = new DynamoDBClient({
  region: process.env.AWS_REGION ?? "us-east-1",
});

const TABLE_NAME = "Aksha_Mobile_Users";

const deleteMobileUser = async (
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

    await dbClient.send(
      new DeleteItemCommand({
        TableName: TABLE_NAME,
        Key: {
          email: { S: email },
        },
      })
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: "User deleted successfully",
      }),
    };
  } catch (error) {
    console.error("Delete Mobile User Error:", error);

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        message: "Internal server error while deleting user",
      }),
    };
  }
};

export default deleteMobileUser;

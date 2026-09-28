import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';

const dbClient = new DynamoDBClient({
    region: process.env.AWS_REGION ?? 'ap-south-1',
});

export const HEALTH_TABLE_NAME = process.env.HEALTH_TABLE_NAME ?? 'Aksha_System_Health';

const getHealthSettings = async (
    event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
    };

    try {
        const siteId = event.queryStringParameters?.siteId;

        if (!siteId) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ message: 'siteId is required' }),
            };
        }

        const result = await dbClient.send(
            new GetItemCommand({
                TableName: HEALTH_TABLE_NAME,
                Key: { siteId: { S: siteId } },
            })
        );

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                message: 'Health settings fetched successfully',
                alert_active_range: result.Item?.alert_active_range?.S ?? '',
                emergency_emails: result.Item?.emergency_emails?.S ?? '',
            }),
        };
    } catch (error) {
        console.error('Get Health Settings Error:', error);

        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ message: 'Internal server error' }),
        };
    }
};

export default getHealthSettings;

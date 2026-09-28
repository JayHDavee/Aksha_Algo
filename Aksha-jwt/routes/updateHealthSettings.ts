import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { HEALTH_TABLE_NAME } from './getHealthSettings';

// ── DYNAMODB CLIENT ───────────────────────────────────────────────────────────
const dbClient = new DynamoDBClient({
    region: process.env.AWS_REGION ?? 'ap-south-1',
});

// ── VALIDATION ─────────────────────────────────────────────────────────────────
const TIME_RANGE_REGEX = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const RequestBodySchema = z.object({
    siteId: z.string().min(1, 'siteId is required'),
    alert_active_range: z
        .string()
        .regex(TIME_RANGE_REGEX, 'alert_active_range must be in "HH:MM-HH:MM" format')
        .optional(),
    emergency_emails: z
        .string()
        .refine((value) => {
            const emails = value.split(',').map((email) => email.trim()).filter(Boolean);
            return emails.length > 0 && emails.every((email) => EMAIL_REGEX.test(email));
        }, 'emergency_emails must be a comma-separated list of valid email addresses')
        .optional(),
});

const updateHealthSettings = async (
    event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (!event.body) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ message: 'Missing request body' }),
        };
    }

    let rawBody: unknown;
    try {
        rawBody = JSON.parse(event.body);
    } catch {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ message: 'Invalid JSON in request body' }),
        };
    }

    const parseResult = RequestBodySchema.safeParse(rawBody);
    if (!parseResult.success) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({
                message: 'Validation failed',
                errors: parseResult.error.flatten().fieldErrors,
            }),
        };
    }

    const { siteId, alert_active_range, emergency_emails } = parseResult.data;

    if (alert_active_range === undefined && emergency_emails === undefined) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ message: 'Provide at least one of alert_active_range or emergency_emails' }),
        };
    }

    // ── Build a SET expression that only touches the attributes present in the
    //    request body, so this endpoint and the health agent's timestamp write
    //    never clobber each other's attributes on the same item. ─────────────
    const setClauses: string[] = [];
    const expressionAttributeNames: Record<string, string> = {};
    const expressionAttributeValues: Record<string, { S: string }> = {};

    if (alert_active_range !== undefined) {
        setClauses.push('#alert_active_range = :alert_active_range');
        expressionAttributeNames['#alert_active_range'] = 'alert_active_range';
        expressionAttributeValues[':alert_active_range'] = { S: alert_active_range };
    }

    if (emergency_emails !== undefined) {
        const normalizedEmails = emergency_emails
            .split(',')
            .map((email) => email.trim())
            .filter(Boolean)
            .join(',');

        setClauses.push('#emergency_emails = :emergency_emails');
        expressionAttributeNames['#emergency_emails'] = 'emergency_emails';
        expressionAttributeValues[':emergency_emails'] = { S: normalizedEmails };
    }

    try {
        await dbClient.send(
            new UpdateItemCommand({
                TableName: HEALTH_TABLE_NAME,
                Key: { siteId: { S: siteId } },
                UpdateExpression: `SET ${setClauses.join(', ')}`,
                ExpressionAttributeNames: expressionAttributeNames,
                ExpressionAttributeValues: expressionAttributeValues,
            })
        );

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ message: 'Health settings updated successfully' }),
        };
    } catch (error) {
        console.error('Update Health Settings Error:', error);

        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ message: 'Internal server error' }),
        };
    }
};

export default updateHealthSettings;

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
    DynamoDBClient,
    GetItemCommand,
    QueryCommand,
} from '@aws-sdk/client-dynamodb';
import { z } from 'zod';

// ── DYNAMODB CLIENT ───────────────────────────────────────────────────────────
const dbClient = new DynamoDBClient({
    region: process.env.AWS_REGION ?? 'ap-south-1',
});

const TABLE_NAME = 'Aksha_Mobile_Users';

// ── REQUEST SCHEMA ────────────────────────────────────────────────────────────
const RequestBodySchema = z.object({
    mobileId: z.string().min(1, 'mobileId is required'),
});

// ── LAMBDA HANDLER ────────────────────────────────────────────────────────────
const getGroups = async (
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

    const { mobileId } = parseResult.data;

    try {
        // ── Find user by mobile_id using GSI ──────────────────────────────────
        const queryResult = await dbClient.send(
            new QueryCommand({
                TableName: TABLE_NAME,
                IndexName: 'mobile_id-index',
                KeyConditionExpression: 'mobile_id = :mid',
                ExpressionAttributeValues: {
                    ':mid': { S: mobileId },
                },
                Limit: 1,
            })
        );

        if (!queryResult.Items || queryResult.Items.length === 0) {
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ groups: [] }),
            };
        }

        const email = queryResult.Items[0].email?.S;
        if (!email) {
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ groups: [] }),
            };
        }

        // ── Get full user record to read groups ───────────────────────────────
        const getResult = await dbClient.send(
            new GetItemCommand({
                TableName: TABLE_NAME,
                Key: { email: { S: email } },
            })
        );

        // ── Parse groups SS → [{ id, name }] ─────────────────────────────────
        // Each entry is stored as "groupId:groupName" e.g. "64abc...:Security Team"
        const groupsRaw: string[] = getResult.Item?.groups?.SS
            ? Array.from(getResult.Item.groups.SS)
            : [];

        const groups = groupsRaw
            .map((entry) => {
                const colonIndex = entry.indexOf(':');
                if (colonIndex === -1) return null;
                return {
                    id:   entry.slice(0, colonIndex),
                    name: entry.slice(colonIndex + 1),
                };
            })
            .filter((g): g is { id: string; name: string } => g !== null);

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ groups }),
        };

    } catch (err) {
        console.error('getGroups error:', err);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ message: 'Internal server error' }),
        };
    }
};

export default getGroups;
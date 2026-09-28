import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import * as bcrypt from 'bcryptjs';
import { z } from 'zod';
import { randomUUID } from 'crypto';

// --- DynamoDB client for Aksha_Mobile_Users table ---
const dbClient = new DynamoDBClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
});

const TABLE_NAME = 'Aksha_Mobile_Users';

const RequestBodySchema = z.object({
    username: z.string().min(3, 'Username must be at least 3 characters'),
    email:    z.string().email('Invalid email address'),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    siteId:   z.string().min(1, 'Site ID is required'),
    notificationsEnabled: z.boolean().optional().default(false),
});

const registerMobileUser = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {

    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
    };

    // --- Validate body presence ---
    if (!event.body) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ message: 'Missing request body' }),
        };
    }

    // --- Parse JSON ---
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

    // --- Validate schema ---
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

    const { username, email, password, siteId, notificationsEnabled } = parseResult.data;

    // --- Auto-generate mobile_id from username + uuid ---
    // Format: <username>_<uuid>  e.g. "john_3f2a1b4c-8e7d-..."
    const mobile_id = `${username}_${randomUUID()}`;

    // --- Hash the password with bcrypt (salt rounds: 10) ---
    const passwordHash = await bcrypt.hash(password, 10);

    // --- Check if email already exists ---
    try {
        const existingEmail = await dbClient.send(
            new GetItemCommand({
                TableName: TABLE_NAME,
                Key: {
                    email: { S: email },
                },
            }),
        );

        if (existingEmail.Item) {
            return {
                statusCode: 409,
                headers,
                body: JSON.stringify({ message: 'An account with this email already exists' }),
            };
        }
    } catch (err) {
        console.error('DynamoDB GetItem error:', err);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ message: 'Internal server error while checking email' }),
        };
    }

    // --- Check if username already exists (requires a GSI on username) ---
    try {
        const existingUsername = await dbClient.send(
            new QueryCommand({
                TableName: TABLE_NAME,
                IndexName: 'username-index',
                KeyConditionExpression: 'username = :u',
                ExpressionAttributeValues: {
                    ':u': { S: username },
                },
                Limit: 1,
            }),
        );

        if (existingUsername.Count && existingUsername.Count > 0) {
            return {
                statusCode: 409,
                headers,
                body: JSON.stringify({ message: 'This username is already taken' }),
            };
        }
    } catch (err) {
        console.error('DynamoDB Query (username GSI) error:', err);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ message: 'Internal server error while checking username' }),
        };
    }

    // --- Write new user to Aksha_Mobile_Users table ---
    // Schema:
    //   email        (S) — partition key
    //   username     (S) — indexed via GSI for login + uniqueness check
    //   mobile_id    (S) — auto-generated: username_uuid
    //   passwordHash (S)
    //   siteId       (S)
    //   expoToken    (S) — added later via updateExpoToken lambda after login
    try {
        await dbClient.send(
            new PutItemCommand({
                TableName: TABLE_NAME,
                Item: {
                    email:        { S: email },
                    username:     { S: username },
                    mobile_id:    { S: mobile_id },
                    passwordHash: { S: passwordHash },
                    siteId:       { S: siteId },
                    notificationsEnabled: { BOOL: notificationsEnabled },
                },
                ConditionExpression: 'attribute_not_exists(email)',
            }),
        );
    } catch (err: any) {
        if (err.name === 'ConditionalCheckFailedException') {
            return {
                statusCode: 409,
                headers,
                body: JSON.stringify({ message: 'An account with this email already exists' }),
            };
        }
        console.error('DynamoDB PutItem error:', err);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ message: 'Internal server error while creating user' }),
        };
    }

    return {
        statusCode: 201,
        headers,
        body: JSON.stringify({
            message: 'Account created successfully',
            username,
            email,
            siteId,
            mobile_id,
        }),
    };
};

export default registerMobileUser;
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient, GetItemCommand, UpdateItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import * as bcrypt from 'bcryptjs';
import * as jose from 'jose';
import { z } from 'zod';

// --- DynamoDB client for Aksha_Mobile_Users table ---
const dbClient = new DynamoDBClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
});

const TABLE_NAME = 'Aksha_Mobile_Users';

const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET || 'your-secret-key');

// --- Schema: identifier can be email or username ---
const RequestBodySchema = z.object({
    identifier: z.string().min(1, 'Username or email is required'),
    password:   z.string().min(1, 'Password is required'),
    expoToken:  z.string().min(1, 'Expo push token is required'),
});

// --- Helper: detect if identifier is an email ---
const isEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const loginMobileUser = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {

    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
    };

    try {
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

        const { identifier, password, expoToken } = parseResult.data;

        let userItem: Record<string, any> | undefined;

        if (isEmail(identifier)) {
            // --- Login by email: direct GetItem on partition key ---
            const userResult = await dbClient.send(
                new GetItemCommand({
                    TableName: TABLE_NAME,
                    Key: { email: { S: identifier } },
                }),
            );
            userItem = userResult.Item;
        } else {
            // --- Login by username: query the username-index GSI ---
            const userResult = await dbClient.send(
                new QueryCommand({
                    TableName: TABLE_NAME,
                    IndexName: 'username-index',
                    KeyConditionExpression: 'username = :u',
                    ExpressionAttributeValues: {
                        ':u': { S: identifier },
                    },
                    Limit: 1,
                }),
            );

            if (userResult.Items && userResult.Items.length > 0) {
                const emailKey = userResult.Items[0].email?.S;

                if (emailKey) {
                    // --- Fetch full item from main table using the email ---
                    const fullUserResult = await dbClient.send(
                        new GetItemCommand({
                            TableName: TABLE_NAME,
                            Key: { email: { S: emailKey } },
                        }),
                    );
                    userItem = fullUserResult.Item;
                }
            }
        }

        // --- User not found ---
        if (!userItem) {
            return {
                statusCode: 401,
                headers,
                body: JSON.stringify({ message: 'Invalid username/email or password' }),
            };
        }

        const storedPasswordHash = userItem.passwordHash?.S;

        if (!storedPasswordHash) {
            return {
                statusCode: 500,
                headers,
                body: JSON.stringify({ message: 'Stored password not found' }),
            };
        }

        // --- Compare password with bcrypt ---
        const isPasswordValid = await bcrypt.compare(password, storedPasswordHash);
        if (!isPasswordValid) {
            return {
                statusCode: 401,
                headers,
                body: JSON.stringify({ message: 'Invalid username/email or password' }),
            };
        }

        const email     = userItem.email?.S     || '';
        const siteId    = userItem.siteId?.S    || '';
        const username  = userItem.username?.S  || '';
        const mobile_id = userItem.mobile_id?.S || ''; // ← added

        // --- Update expoToken on successful login ---
        await dbClient.send(
            new UpdateItemCommand({
                TableName: TABLE_NAME,
                Key: { email: { S: email } },
                UpdateExpression: 'SET expoToken = :token',
                ExpressionAttributeValues: {
                    ':token': { S: expoToken },
                },
            }),
        );

        // --- Generate JWT token ---
        const jwtToken = await new jose.SignJWT({
            email,
            username,
            siteId,
            mobile_id, // ← added
        })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuedAt()
            .setIssuer('mobile-app')
            .setExpirationTime('15d')
            .sign(JWT_SECRET);

        return {
            statusCode: 200,
            headers: {
                ...headers,
                'Set-Cookie': `token=${jwtToken}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=1296000;`,
            },
            body: JSON.stringify({
                message:   'Login successful',
                email,
                username,
                siteId,
                mobile_id, // ← added
                token:     jwtToken,
            }),
        };

    } catch (err) {
        console.error('Error in loginMobileUser:', err);

        if (err instanceof z.ZodError) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({
                    message: 'Invalid input',
                    errors: err.errors,
                }),
            };
        }

        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
                message: 'Internal server error',
                error: err instanceof Error ? err.message : JSON.stringify(err),
            }),
        };
    }
};

export default loginMobileUser;
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { dbClient } from '../models/dbClient';

const RequestBodySchema = z.object({
    email: z.string().email(),
    passwordHash: z.string(), // already hashed from frontend
});

const resetPassword = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        if (!event.body) {
        return {
            statusCode: 400,
            body: JSON.stringify({
                message: 'Missing body',
            }),
        };
    }
    const rawbody = JSON.parse(event.body);



    if (!rawbody) {
        return {
            statusCode: 400,
            body: JSON.stringify({
                message: 'Missing required fields',
            }),
        };
    }
    const body = RequestBodySchema.parse(rawbody);

    if (!body) {
        return {
            statusCode: 400,
            body: JSON.stringify({
                message: 'Missing required fields and cannot parse body',
            }),
        };
    }

    const { email, passwordHash } = body;

    // Step 1: Check if user exists
    const checkUser = await dbClient.send(
        new GetItemCommand({
            TableName: process.env.TABLE_NAME!,
            Key: { email: { S: email } },
        }),
    );

    if (!checkUser.Item) {
        return {
            statusCode: 404,
            body: JSON.stringify({ message: 'User not found' }),
        };
    }

    // Step 2: Update the password hash directly
    await dbClient.send(
        new UpdateItemCommand({
            TableName: process.env.TABLE_NAME!,
            Key: { email: { S: email } },
            UpdateExpression: 'SET passwordHash = :ph',
            ExpressionAttributeValues: {
                ':ph': { S: passwordHash },
            },
        }),
    );

    return {
        statusCode: 200,
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: 'Password updated successfully' }),
    };
    } catch (err) {
        console.error('Error in loginUser:', err);

        if (err instanceof z.ZodError) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    message: 'Invalid input',
                    errors: err.errors,
                }),
            };
        }

        return {
            statusCode: 500,
            body: JSON.stringify({
                message: 'Internal server error',
                error: err instanceof Error ? err.message : JSON.stringify(err),
            }),
        };
    }
};

export default resetPassword;

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { dbClient } from '../models/dbClient';
import { sendPasswordResetEmail } from '../email/sesClient';
import crypto from 'crypto';

// Define the schema to validate the input
const RequestBodySchema = z.object({
    // email: z.string().email()
    email: z.string(),
});

// function to verify the reset token
export const verifyToken = async (email: string, token: string): Promise<boolean> => {
    try {
        // Querying DynamoDB to check token expiry and value
        const user = await dbClient.send(
            new GetItemCommand({
                TableName: process.env.TABLE_NAME,
                Key: { email: { S: email } },
            }),
        );

        if (!user.Item) {
            return false; // User not found//working
        }

        const storedToken = user.Item.resetToken?.S;
        const storedExpiry = parseInt(user.Item.resetTokenExpiry?.N ?? '0', 10);

        // Check if token matches and if it has expired
        if (storedToken !== token || Date.now() / 1000 > storedExpiry) {
            return false; // Invalid token or expired
        }

        return true;
    } catch (err) {
        console.error('Error verifying token:', err);
        return false;
    }
};

const forgotPassword = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        // Check if request body exists
        if (!event.body) {
            console.log('missing request/email body');
            return {
                statusCode: 400,
                body: JSON.stringify({ message: 'Missing request body' }), //working
            };
        }

        const rawBody = JSON.parse(event.body);

        if (!rawBody) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    message: 'Missing required fields',
                }),
            };
        }

        const body = RequestBodySchema.parse(rawBody);

        if (!body) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    message: 'Missing required fields and cannot parse body',
                }),
            };
        }

        const { email } = body;

        // Ensure email is not empty or invalid
        if (!email || email.trim() === '') {
            console.error('Invalid email input:', email);
            return {
                statusCode: 400,
                body: JSON.stringify({ message: 'Email is required' }),
            };
        }

        // Query the user from the DynamoDB table
        const checkUser = await dbClient.send(
            new GetItemCommand({
                TableName: process.env.TABLE_NAME,
                Key: { email: { S: email } },
            }),
        );

        if (!checkUser.Item) {
            return {
                statusCode: 404,
                body: JSON.stringify({ message: 'User not found' }), //working
            };
        }

        // Securely generating a reset token
        const resetToken = crypto.randomBytes(32).toString('hex'); // Use crypto for secure token

        // For storing the reset token and expiration time (1 hour) in DynamoDB
        const expiryTime = Math.floor(Date.now() / 1000) + 3600; // 1 hour expiry

        await dbClient.send(
            new UpdateItemCommand({
                TableName: process.env.TABLE_NAME,
                Key: { email: { S: email } },
                UpdateExpression: 'SET resetToken = :token, resetTokenExpiry = :expiry',
                ExpressionAttributeValues: {
                    ':token': { S: resetToken },
                    ':expiry': { N: expiryTime.toString() },
                },
            }),
        );

        // Creates the reset password link and sends it via email
        const resetLink = `${process.env.CLIENT_ORIGIN}/reset-password?token=${encodeURIComponent(
            resetToken,
        )}&email=${encodeURIComponent(email)}`;

        // const resetLink = `${process.env.FUNCTION_URL}/reset-password?token=${resetToken}&email=${email}`;

        await sendPasswordResetEmail(email, resetLink);

        return {
            statusCode: 200,
            body: JSON.stringify({ message: 'Password reset link sent to your email' }),
        };
    } catch (err) {
        console.error('Error in forgotPassword:', err);

        if (err instanceof z.ZodError) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    message: 'Invalid input',
                    errors: err.errors,
                }),
            };
        }

        // Catch all other errors
        return {
            statusCode: 500,
            body: JSON.stringify({
                message: 'Internal server error',
                error: err instanceof Error ? err.message : JSON.stringify(err),
            }),
        };
    }
};

export default forgotPassword;

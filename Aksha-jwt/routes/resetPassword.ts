import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { dbClient } from '../models/dbClient';
import crypto from 'crypto';
import { verifyToken} from "./forgotPassword"; 

// Load secret key used for HMAC (same as frontend's)
const SECRET_KEY = process.env.PASSWORD_SECRET_KEY!;
if (!SECRET_KEY) {
    throw new Error('SECRET_KEY environment variable is required');
}


// Schema to validate the input
const RequestBodySchema = z.object({
    token: z.string(),
    email: z.string().email(),
    newPassword: z.string().min(8, 'Password must be at least 8 characters long'),
    confirmPassword: z.string(),
}).refine((data) => data.newPassword === data.confirmPassword, {
    message: "Passwords don't match",
    path: ['confirmPassword'], // Path of error in validation
});


// Function to hash password 
const hashPassword = (password: string): string => {
    return crypto
        .createHmac('sha256', SECRET_KEY)
        .update(password)
        .digest('hex');
};

const resetPassword = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        if (!event.body) {
            return {
                statusCode: 400,
                body: JSON.stringify({ message: 'Missing request body' }),
            };
        }

        const rawbody = JSON.parse(event.body);
        const body = RequestBodySchema.parse(rawbody);
        const { token, email, newPassword } = body;

        // UsING the verifyToken function to validate the token and expiry
        const isValidToken = await verifyToken(email, token);

        if (!isValidToken) {
            return {
                statusCode: 400,
                body: JSON.stringify({ message: 'Invalid or expired reset token' }),
            };
        }

        // Hash the new password 
        const hashedPassword = hashPassword(newPassword);

        // Update the password and remove the reset token from DynamoDB
         await dbClient.send(
            new UpdateItemCommand({
                TableName: process.env.TABLE_NAME!,
                Key: { email: { S: email } },
                UpdateExpression: 'SET passwordHash = :passwordHash REMOVE resetToken, resetTokenExpiry',
                ExpressionAttributeValues: {
                    ':passwordHash': { S: hashedPassword },
                },
            })
        );

        return {
            statusCode: 200,
            body: JSON.stringify({ message: 'Password successfully reset' }),
        };
    } catch (err) {
        console.error('Error in resetPassword:', err);

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
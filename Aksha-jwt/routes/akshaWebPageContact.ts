import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { PutItemCommand } from '@aws-sdk/client-dynamodb';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { z } from 'zod';
import { dbClient } from '../models/dbClient';

const sesClient = new SESClient({
  region: process.env.AWS_REGION || 'ap-south-1',
});

// Validation schema
const ContactSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email'),
  phone: z.string().optional(),
  company: z.string().optional(),
  message: z.string().min(1, 'Message is required'),
});

const contact = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    if (!event.body) {
      return { statusCode: 400, body: JSON.stringify({ message: 'Missing body' }) };
    }

    const rawBody = JSON.parse(event.body);
    const body = ContactSchema.parse(rawBody);

    const { name, email, phone, company, message } = body;
    const timestamp = new Date().toISOString();

    /* -------------------- 1️⃣ Save to DynamoDB -------------------- */
    await dbClient.send(
      new PutItemCommand({
        TableName: process.env.DB_NAME!,
        Item: {
          email: { S: email },
          name: { S: name },
          phone: { S: phone || 'N/A' },
          company: { S: company || 'N/A' },
          message: { S: message },
          timestamp: { S: timestamp },
        },
      })
    );

    /* -------------------- 2️⃣ HTML Email -------------------- */

    const htmlBody = `
  <div style="
    font-family: Arial, Helvetica, sans-serif;
    background-color:#f2f4f7;
    padding:24px;
    color:#000000;
  ">

    <div style="
      max-width:600px;
      margin:0 auto;
      background:#ffffff;
      border-radius:8px;
      padding:24px;
      box-shadow:0 2px 6px rgba(0,0,0,0.08);
    ">

      <h2 style="color:#1f4fd8; margin-top:0;">
        Thanks for contacting us
      </h2>

      <p style="font-size:15px;">
        We’ve received your message successfully.
        <strong style="color:#000000;">
          The AlgoAnalytics team will contact you shortly.
        </strong>
      </p>

      <p style="margin-top:20px; font-size:14px;">
        Please find your submitted details below:
      </p>

      <div style="
        margin-top:12px;
        padding:16px;
        background:#f2f4f7;
        border-left:4px solid #1f4fd8;
        border-radius:6px;
      ">
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Phone:</strong> ${phone || 'N/A'}</p>
        <p><strong>Company:</strong> ${company || 'N/A'}</p>
        <p><strong>Message:</strong><br/>${message}</p>
        <p style="font-size:12px; color:#444444; margin-top:12px;">
          Submitted on ${timestamp}
        </p>
      </div>

      <br/>

      <p style="font-size:14px;">
        Regards,<br/>
        <strong style="color:#000000;">AlgoAnalytics Team</strong>
      </p>

    </div>

  </div>
`;

    /* -------------------- 3️⃣ Send SES Email (Internal Only) -------------------- */
    await sesClient.send(
      new SendEmailCommand({
        Source: process.env.SES_EMAIL_FROM!,
        Destination: {
          ToAddresses: [process.env.SES_EMAIL_INTERNAL_1!],
          CcAddresses: [process.env.SES_EMAIL_INTERNAL_2!],
        },
        Message: {
          Subject: {
            Data: `New Contact Submission – ${name}`,
          },
          Body: {
            Html: {
              Data: htmlBody,
            },
          },
        },
      })
    );

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({
        success: true,
        message: 'Contact saved successfully',
      }),
    };
  } catch (err: any) {
    console.error('Contact API error:', err);

    if (err instanceof z.ZodError) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          message: 'Validation failed',
          errors: err.errors,
        }),
      };
    }

    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Internal server error',
        error: err.message,
      }),
    };
  }
};

export default contact;

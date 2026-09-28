import { SESClient, SendEmailCommand, SendEmailCommandInput } from '@aws-sdk/client-ses';
import { generateEmailSecret } from '../functions/emailSecret';
import { APIGatewayEvent } from 'aws-lambda';

const sesClient = new SESClient({ region: 'ap-south-1' });

interface SendReqScopeEmailParams {
    email: string;
    password?: string;
    scopes: string[];
}

const checkMailConfig = () => {
    const sourceEmail = process.env.SOURCE_EMAIL;
    const adminEmails = process.env.ADMIN_EMAILS;
    const supportEmails = process.env.SUPPORT_EMAILS;
    const functionURL = process.env.FUNCTION_URL;

    console.log({ sourceEmail, adminEmails, supportEmails, functionURL });

    if (!sourceEmail || !supportEmails || !adminEmails || !functionURL) {
        throw new Error('Email configuration is missing in env');
    }

    return { sourceEmail, supportEmails: supportEmails.split(','), adminEmails: adminEmails.split(','), functionURL };
};

export async function sendReqScopeEmail({ email, scopes }: SendReqScopeEmailParams): Promise<void> {
    // Check if the email configuration is set
    const { sourceEmail, supportEmails, adminEmails, functionURL } = checkMailConfig();

    const encodedScopes = encodeURIComponent(scopes.join(','));
    const oneOffSecret = encodeURIComponent(generateEmailSecret(email, scopes));
    // FIXME: Update function path to grantAccess
    const link = `${functionURL}/grantAccess?email=${encodeURIComponent(
        email,
    )}&scopes=${encodedScopes}&key=${oneOffSecret}`;

    const params: SendEmailCommandInput = {
        Destination: {
            ToAddresses: [...adminEmails],
        },
        Message: {
            Body: {
                Html: {
                    Charset: 'UTF-8',
                    Data: `
                              <!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>New Page Request</title>
  <style>
    body {
      font-family: 'Arial', sans-serif;
      line-height: 1.6;
      /*new*/
      margin: 0;
      padding: 0;
      background-color: #f4f4f4;
    }

    table {
      border-spacing: 0;
      font-family: 'Arial', sans-serif;
    }

    h2 {
      color: #333;
      margin: 0;
      font-size: 30px;

    }

    p {
      margin: 10px 0;
      color: #555;
    }

    a {
      color: #007bff;
      text-decoration: none;
    }

    a:hover {
      text-decoration: underline;
    }

    hr {
      border: 0;
      height: 1px;
      background-color: #ddd;
      margin: 20px 0;
    }

    /* Button styles */
  
    .button {
      background: linear-gradient(to right,#B7B7B7,#DBD3D3);
      border: none;
      color: white!important;
      padding: 12px 40px;
      text-align: center;
      text-decoration: none;
      display: inline-block;
      font-size: 18px;
      margin: 18px 0;
      /*border-radius: 50px;*/
      transition: all 0.3s ease;
      box-shadow: 0px 6px 12px rgba(0, 0, 0, 0.15); /* Depth effect */
      width: 100%;
      max-width: 200px;
    }

    .button:hover {
      background: linear-gradient(to right, #005f8d, #0077b6);
      transform: scale(1.05); /* Slight enlargement on hover */
      text-decoration: none;
      box-shadow: 0px 8px 16px rgba(0, 0, 0, 0.2); /* Enhanced shadow on hover */
    }

    /* Container styles */
    .email-container {
      width: 100%;
      max-width: 600px;
      background-color: white;
      margin: 0 auto;
      border-radius: 8px;
      box-shadow: 0px 4px 12px rgba(0, 0, 0, 0.1);
      overflow: hidden;
    }

     .email-header {
      background: linear-gradient(to right,#B7B7B7,#F5F5F7);
      color: white;
      text-align: center;
      padding: 30px 0;
      position: relative;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
      border-bottom: 1px solid #ddd;
    }

    .email-header img {
      width: 100%;
      max-width: 150px;
      opacity: 0.9; /* Slight fade effect on the logo */
    }


    .email-body {
      padding: 25px;
      border-bottom: 1px solid #ddd;
    }

    .email-footer {
      text-align: center;
      font-size: 12px;
      color: #aaa;
      padding: 20px;
      background-color: #f9f9f9;
    }

    .decorative-line {
      width: 50px;
      height: 4px;
      background-color: #0077b6;
      margin: 20px auto;
      border-radius: 2px;
    }
  </style>
</head>
<body>
  <table border="0" cellpadding="0" cellspacing="0" width="100%" style="padding: 10px">
    <tr>
      <td align="center">
        <table class="email-container">
          <!-- Header -->
          <tr>
            <td class="email-header">
              <img
                src="https://algoAksha.algoanalytics.com/assets/images/landingv2/main-logo.png"
                alt="AlgoAksha"
              />
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td class="email-body">
              <h2>New Page Request</h2>
              <div class="decorative-line"></div> 
              <p>A New Page Request has been Received.</p>
              <p><strong>Email:</strong> ${email}</p>
              <p><strong>Requested Pages:</strong> ${scopes
  .map(scope => scope.charAt(0).toUpperCase() + scope.slice(1))
  .join(', ')}</p>
              <p>Click the button below to approve.</p>
              <p style="text-align: center;">
                <a class="button" href="${link}">Approve Request</a>
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td class="email-footer">
              <p>This is an automated message. Please do not reply.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`,
                },
                Text: {
                    Charset: 'UTF-8',
                    Data: `
                      New Page Request
    
                      A new Page request has been received:
                      Email: ${email}
                      Requested Pages: ${scopes.join(', ')}
    
                      Click the link below to approve:
                      ${link}
                    `,
                },
            },
            Subject: {
                Charset: 'UTF-8',
                Data: 'Aksha: Page Access Request',
            },
        },
        ReplyToAddresses: supportEmails,
        Source: sourceEmail, // Replace with your SES verified email
    };
    
    try {
        const command = new SendEmailCommand(params);
        const result = await sesClient.send(command);
        console.log('Email sent successfully:', result.MessageId);
    } catch (error) {
        console.error('Error sending email:', error);
        throw error;
    }
}

export async function sendGrantedScopeEmail({ email, scopes }: SendReqScopeEmailParams): Promise<void> {
    // Check if the email configuration is set
    const { sourceEmail, supportEmails, adminEmails } = checkMailConfig();

    // Cannot send email to user from sandbox account in SES
    const ToAddresses = [email, ...adminEmails];
    // process.env.SES_MAILONLYADMIN ? [...adminEmails] :

    const params: SendEmailCommandInput = {
        Destination: {
            ToAddresses: ToAddresses,
        },
        Message: {
            Body: {
                Html: {
                    Charset: 'UTF-8',
                    Data: `
                     <!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Access Request Status</title>
  <style>
    body {
      font-family: 'Arial', sans-serif;
      line-height: 1.6;
      /*new */
      margin: 0;
      padding: 0;
      background-color: #f4f4f4;
    }

    table {
      border-spacing: 0;
      font-family: 'Arial', sans-serif;
    }

    h2 {
      color: #333;
      margin: 0;
      font-size: 30px;
    }

    p {
      margin: 10px 0;
      color: #555;
    }

    ul {
      padding-left: 20px;
    }

    ul li {
      margin: 5px 0;
    }

    /* Granted status styles */
    .status-granted {
      font-size: 18px;
      font-weight: bold;
      color: #28a745; /* Green color for success */
      margin-bottom: 10px;
    }

    /* Container styles */
    .email-container {
      width: 100%;
      max-width: 600px;
      background-color: white;
      margin: 0 auto;
      border-radius: 8px;
      box-shadow: 0px 4px 12px rgba(0, 0, 0, 0.1);
      overflow: hidden;
    }

    .email-header {
      background: linear-gradient(to right,#B7B7B7,#F5F5F7);
      color: white;
      text-align: center;
      padding: 30px 0;
      position: relative;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
      border-bottom: 1px solid #ddd;
    }

    .email-header img {
      width: 100%;
      max-width: 150px;
      opacity: 0.9; /* Slight fade effect on the logo */
    }

    .email-body {
      padding: 25px;
      border-bottom: 1px solid #ddd;
    }

    .email-footer {
      text-align: center;
      font-size: 12px;
      color: #aaa;
      padding: 20px;
      background-color: #f9f9f9;
    }

    /* Decorative styles */
    .decorative-line {
      width: 50px;
      height: 4px;
      background-color: #0077b6;
      margin: 20px auto;
      border-radius: 2px;
    }
  </style>
</head>
<body>
  <table border="0" cellpadding="0" cellspacing="0" width="100%" style="padding: 10px">
    <tr>
      <td align="center">
        <table class="email-container">
          <!-- Header -->
          <tr>
            <td class="email-header">
              <img
                src="https://algoAksha.algoanalytics.com/assets/images/landingv2/main-logo.png"
                alt="AlgoAksha"
              />
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td class="email-body">
              <h2>Access Request Status</h2>
              <div class="decorative-line"></div> <!-- Decorative line under title -->
              <p class="status-granted">Access Granted ! 🎉</p>
              <p>Your Request For The Following Pages Has Been Granted !</p>
            <ul>
  ${scopes.map(scope => `<li>${scope.charAt(0).toUpperCase() + scope.slice(1)}</li>`).join('')}
</ul>

              <p>Login Again To Access The Requested Pages.<br> If you have any further questions, feel free to contact the Support Team.</p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td class="email-footer">
              <p>This is an automated message. Please do not reply.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
                },
            },
            Subject: {
                Charset: 'UTF-8',
                Data: 'Aksha: Page Access Granted',
            },
        },
        ReplyToAddresses: supportEmails,
        Source: sourceEmail, // Replace with your SES verified email
    };

    try {
        const command = new SendEmailCommand(params);
        const result = await sesClient.send(command);
        console.log('Email sent successfully:', result.MessageId);
    } catch (error) {
        console.error('Error sending email:', error);
        throw error;
    }
}

export async function sendRegisterVerificationEmail(email: string, secret: string): Promise<void> {
    // Check if the email configuration is set
    const { sourceEmail, supportEmails, functionURL } = checkMailConfig();

    const link = `${functionURL}/verifyEmail?email=${encodeURIComponent(email)}&key=${encodeURIComponent(secret)}`;

    const params: SendEmailCommandInput = {
        Destination: {
            ToAddresses: [email],
        },
        Message: {
            Body: {
                Html: {
                    Charset: 'UTF-8',
                    Data: `
                    <!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Verify Your Email</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      background-color: #f4f4f4;
      /*new*/
      margin: 0;
      padding: 0;
    }

    h2 {
      color: #333;
      font-size: 30px;
      margin: 0;
    }

    p {
      margin: 10px 0;
      color: #555;
    }

    .email-container {
      width: 100%;
      max-width: 600px;
      background-color: white;
      margin: 0 auto;
      border-radius: 8px;
      box-shadow: 0px 4px 12px rgba(0, 0, 0, 0.1);
      overflow: hidden;
    }

       .email-header {
      background: linear-gradient(to right,#B7B7B7,#F5F5F7);
      color: white;
      text-align: center;
      padding: 30px 0;
      position: relative;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
      border-bottom: 1px solid #ddd;
    }

    .email-header img {
      width: 100%;
      max-width: 150px;
      opacity: 0.9; /* Slight fade effect on the logo */
    }


    .email-body {
      padding: 25px;
      border-bottom: 1px solid #ddd;
    }

    /* Button styling */
    .button {
      background: linear-gradient(to right,#B7B7B7,#DBD3D3);
      border: none;
      color: white!important;
      padding: 12px 40px;
      text-align: center;
      text-decoration: none;
      display: inline-block;
      font-size: 18px;
      margin: 18px 0;
      /*border-radius: 50px;*/
      transition: all 0.3s ease;
      box-shadow: 0px 6px 12px rgba(0, 0, 0, 0.15); /* Depth effect */
      width: 100%;
      max-width: 200px;
    }

    .button:hover {
      background: linear-gradient(to right, #005f8d, #0077b6);
      transform: scale(1.05); /* Slight enlargement on hover */
      text-decoration: none;
      box-shadow: 0px 8px 16px rgba(0, 0, 0, 0.2); /* Enhanced shadow on hover */
    }

    /* Footer */
    .email-footer {
      text-align: center;
      font-size: 12px;
      color: #aaa;
      padding: 20px;
      background-color: #f9f9f9;
    }

    .decorative-line {
      width: 50px;
      height: 4px;
      background-color: #0077b6;
      margin: 20px auto;
      border-radius: 2px;
    }
  </style>
</head>
<body>
  <table border="0" cellpadding="0" cellspacing="0" width="100%" style="padding: 10px">
    <tr>
      <td align="center">
        <table class="email-container">
          <!-- Header -->
          <tr>
            <td class="email-header">
              <img src="https://algoAksha.algoanalytics.com/assets/images/landingv2/main-logo.png" alt="AlgoAksha" />
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td class="email-body">
              <h2>Verify Your Email</h2>
              <div class="decorative-line"></div> <!-- Decorative line under title -->
              <p>Click the button below to verify your email.</p>
              <p style="text-align: center;">
                <a class="button" href="${link}">Verify Email</a>
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td class="email-footer">
              <p>This is an automated message. Please do not reply.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
          `,
                },
            },
            Subject: {
                Charset: 'UTF-8',
                Data: 'Aksha: Email Verification',
            },
        },
        ReplyToAddresses: supportEmails,
        Source: sourceEmail, // Replace with your SES verified email
    };

    try {
        const command = new SendEmailCommand(params);
        const result = await sesClient.send(command);
        console.log('Email sent successfully:', result.MessageId);
    } catch (error) {
        console.error('Error sending email:', error);
        throw error;
    }
}

export async function sendPasswordResetEmail(email: string, secret: string): Promise<void> {
  // Check if the email configuration is set
  console.log("Sending reset email received:", email);
  console.log("Reset link received:", secret);

  const { sourceEmail, supportEmails, functionURL } = checkMailConfig();

  // const link = `${functionURL}/reset-password?token=${encodeURIComponent(secret)}&email=${encodeURIComponent(email)}`;
  
  const link = secret;
  const params: SendEmailCommandInput = {
      Destination: {
          ToAddresses: [email],
      },
      Message: {
          Body: {
              Html: {
                  Charset: 'UTF-8',
                  Data:`
                  <!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Verify Your Email</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      background-color: #f4f4f4;
      /*new*/
      margin: 0;
      padding: 0;
    }

    h2 {
      color: #333;
      font-size: 30px;
      margin: 0;
    }

    p {
      margin: 10px 0;
      color: #555;
    }

    .email-container {
      width: 100%;
      max-width: 600px;
      background-color: white;
      margin: 0 auto;
      border-radius: 8px;
      box-shadow: 0px 4px 12px rgba(0, 0, 0, 0.1);
      overflow: hidden;
    }

       .email-header {
      background: linear-gradient(to right,#B7B7B7,#F5F5F7);
      color: white;
      text-align: center;
      padding: 30px 0;
      position: relative;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
      border-bottom: 1px solid #ddd;
    }

    .email-header img {
      width: 100%;
      max-width: 150px;
      opacity: 0.9; /* Slight fade effect on the logo */
    }


    .email-body {
      padding: 25px;
      border-bottom: 1px solid #ddd;
    }

    /* Button styling */
    .button {
      background: linear-gradient(to right,#B7B7B7,#DBD3D3);
      border: none;
      color: white!important;
      padding: 12px 40px;
      text-align: center;
      text-decoration: none;
      display: inline-block;
      font-size: 18px;
      margin: 18px 0;
      /*border-radius: 50px;*/
      transition: all 0.3s ease;
      box-shadow: 0px 6px 12px rgba(0, 0, 0, 0.15); /* Depth effect */
      width: 100%;
      max-width: 200px;
    }

    .button:hover {
      background: linear-gradient(to right, #005f8d, #0077b6);
      transform: scale(1.05); /* Slight enlargement on hover */
      text-decoration: none;
      box-shadow: 0px 8px 16px rgba(0, 0, 0, 0.2); /* Enhanced shadow on hover */
    }

    /* Footer */
    .email-footer {
      text-align: center;
      font-size: 12px;
      color: #aaa;
      padding: 20px;
      background-color: #f9f9f9;
    }

    .decorative-line {
      width: 50px;
      height: 4px;
      background-color: #0077b6;
      margin: 20px auto;
      border-radius: 2px;
    }
  </style>
</head>
<body>
  <table border="0" cellpadding="0" cellspacing="0" width="100%" style="padding: 10px">
    <tr>
      <td align="center">
        <table class="email-container">
          <!-- Header -->
          <tr>
            <td class="email-header">
              <img src="https://algoAksha.algoanalytics.com/assets/images/landingv2/main-logo.png" alt="AlgoAksha" />
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td class="email-body">
              <h2>Reset Login Password</h2>
              <div class="decorative-line"></div> <!-- Decorative line under title -->
              <p>Click the button below to allow reset password.</p>
              <p style="text-align: center;">
                <a class="button" href="${link}">Reset Password</a>
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td class="email-footer">
              <p>This is an automated message. Please do not reply.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
                },
              },
              Subject: {
                  Charset: 'UTF-8',
                  Data: 'Aksha: Reset Login Password',
              },
          },
          ReplyToAddresses: supportEmails,
          Source: sourceEmail, // Replace with your SES verified email
      };
  
      try {
          const command = new SendEmailCommand(params);
          const result = await sesClient.send(command);
          console.log('Email sent successfully:', result.MessageId);
      } catch (error) {
          console.error('Error sending email:', error);
          throw error;
      }
  }
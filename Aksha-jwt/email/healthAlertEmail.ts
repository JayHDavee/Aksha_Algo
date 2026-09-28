import { SESClient, SendEmailCommand, SendEmailCommandInput } from '@aws-sdk/client-ses';

const sesClient = new SESClient({ region: process.env.AWS_REGION ?? 'ap-south-1' });

const checkMailConfig = () => {
    const sourceEmail = process.env.SOURCE_EMAIL;

    if (!sourceEmail) {
        throw new Error('Email configuration is missing in env (SOURCE_EMAIL)');
    }

    return { sourceEmail };
};

const formatIST = (epochSeconds: number): string =>
    new Date(epochSeconds * 1000).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        dateStyle: 'medium',
        timeStyle: 'medium',
    });

const formatDuration = (totalSeconds: number): string => {
    const minutes = Math.floor(totalSeconds / 60);
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;

    if (hours > 0) {
        return `${hours}h ${remainingMinutes}m`;
    }
    return `${remainingMinutes}m`;
};

export interface HealthDiagnostics {
    // Written every check cycle by the local health agent, healthy or not —
    // may be stale/absent if the agent itself has stopped reporting entirely.
    lastCheckAt?: number;
    coreContainersOk?: boolean;
    missingCoreContainers?: string;
    pipelineRunning?: boolean;
    internetReachable?: boolean;
    failedChecks?: string;
}

const statusPill = (ok: boolean | undefined): string => {
    if (ok === undefined) return '<span class="pill pill-unknown">UNKNOWN</span>';
    return ok ? '<span class="pill pill-ok">OK</span>' : '<span class="pill pill-fail">FAILED</span>';
};

export async function sendSystemDownAlertEmail(
    siteId: string,
    recipients: string[],
    lastSeenEpoch: number,
    diagnostics?: HealthDiagnostics
): Promise<void> {
    const { sourceEmail } = checkMailConfig();

    const nowEpoch = Math.floor(Date.now() / 1000);
    const downtimeSeconds = nowEpoch - lastSeenEpoch;

    const missingContainers = diagnostics?.missingCoreContainers
        ? diagnostics.missingCoreContainers.split(',').filter(Boolean).join(', ')
        : '';

    const params: SendEmailCommandInput = {
        Destination: {
            ToAddresses: recipients,
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
  <title>Aksha System Down</title>
  <style>
    body {
      font-family: 'Arial', sans-serif;
      line-height: 1.6;
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
      font-size: 28px;
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
      background: linear-gradient(to right, #d64545, #f2994a);
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
      opacity: 0.95;
    }

    .status-badge {
      display: inline-block;
      background-color: #d64545;
      color: white;
      font-size: 13px;
      font-weight: bold;
      letter-spacing: 0.5px;
      padding: 6px 16px;
      border-radius: 20px;
      margin-bottom: 10px;
      text-transform: uppercase;
    }

    .email-body {
      padding: 25px;
      border-bottom: 1px solid #ddd;
    }

    .detail-table {
      width: 100%;
      margin: 15px 0;
      border-collapse: collapse;
    }

    .detail-table td {
      padding: 8px 0;
      border-bottom: 1px solid #eee;
      color: #555;
    }

    .detail-table td.label {
      font-weight: bold;
      color: #333;
      width: 40%;
    }

    .section-heading {
      font-size: 15px;
      font-weight: bold;
      color: #333;
      margin: 20px 0 8px;
    }

    .pill {
      display: inline-block;
      font-size: 11px;
      font-weight: bold;
      letter-spacing: 0.4px;
      padding: 3px 10px;
      border-radius: 12px;
    }

    .pill-ok {
      background-color: #e5f6ea;
      color: #1e8a42;
    }

    .pill-fail {
      background-color: #fdeaea;
      color: #c0392b;
    }

    .pill-unknown {
      background-color: #f0f0f0;
      color: #777;
    }

    .email-footer {
      text-align: center;
      font-size: 12px;
      color: #aaa;
      padding: 20px;
      background-color: #f9f9f9;
    }

    .footer-brand {
      font-weight: bold;
      color: #d64545;
      letter-spacing: 0.3px;
    }

    .decorative-line {
      width: 50px;
      height: 4px;
      background-color: #d64545;
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
              <div class="status-badge">System Down</div>
              <h2>Aksha System Health Alert</h2>
              <div class="decorative-line"></div>
              <p>The Aksha deployment below has not reported a heartbeat within the expected window. Please check on it as soon as possible.</p>
              <table class="detail-table">
                <tr>
                  <td class="label">Site</td>
                  <td>${siteId}</td>
                </tr>
                <tr>
                  <td class="label">Last seen</td>
                  <td>${formatIST(lastSeenEpoch)} IST</td>
                </tr>
                <tr>
                  <td class="label">Downtime</td>
                  <td>${formatDuration(downtimeSeconds)}</td>
                </tr>
              </table>

              ${diagnostics ? `
              <div class="section-heading">Diagnostic Report</div>
              <table class="detail-table">
                <tr>
                  <td class="label">Core containers</td>
                  <td>${statusPill(diagnostics.coreContainersOk)}${missingContainers ? ` &mdash; missing: ${missingContainers}` : ''}</td>
                </tr>
                <tr>
                  <td class="label">Detection pipeline</td>
                  <td>${statusPill(diagnostics.pipelineRunning)}</td>
                </tr>
                <tr>
                  <td class="label">Internet connectivity</td>
                  <td>${statusPill(diagnostics.internetReachable)}</td>
                </tr>
                <tr>
                  <td class="label">Last checked</td>
                  <td>${diagnostics.lastCheckAt ? `${formatIST(diagnostics.lastCheckAt)} IST` : 'unknown — health agent may be down'}</td>
                </tr>
              </table>
              ` : ''}

              <p>You are receiving this because your email is configured as an emergency contact for this site in the Aksha Notification Manager.</p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td class="email-footer">
              <p>This is an automated message. Please do not reply.</p>
              <p><span class="footer-brand">AlgoAnalytics</span> &mdash; Powered by Aksha</p>
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
Aksha System Health Alert — System Down

Site: ${siteId}
Last seen: ${formatIST(lastSeenEpoch)} IST
Downtime: ${formatDuration(downtimeSeconds)}
${diagnostics ? `
Diagnostic Report
Core containers: ${diagnostics.coreContainersOk === undefined ? 'UNKNOWN' : diagnostics.coreContainersOk ? 'OK' : 'FAILED'}${missingContainers ? ` (missing: ${missingContainers})` : ''}
Detection pipeline: ${diagnostics.pipelineRunning === undefined ? 'UNKNOWN' : diagnostics.pipelineRunning ? 'OK' : 'FAILED'}
Internet connectivity: ${diagnostics.internetReachable === undefined ? 'UNKNOWN' : diagnostics.internetReachable ? 'OK' : 'FAILED'}
Last checked: ${diagnostics.lastCheckAt ? `${formatIST(diagnostics.lastCheckAt)} IST` : 'unknown — health agent may be down'}
` : ''}
You are receiving this because your email is configured as an emergency contact for this site in the Aksha Notification Manager.
`,
                },
            },
            Subject: {
                Charset: 'UTF-8',
                Data: `Aksha Alert: ${siteId} system down`,
            },
        },
        Source: sourceEmail,
    };

    try {
        const command = new SendEmailCommand(params);
        const result = await sesClient.send(command);
        console.log('Health alert email sent successfully:', result.MessageId);
    } catch (error) {
        console.error('Error sending health alert email:', error);
        throw error;
    }
}

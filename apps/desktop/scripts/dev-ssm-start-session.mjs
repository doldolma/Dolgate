#!/usr/bin/env node
// Dev spike helper: issue an SSM session token with the AWS SDK (no aws CLI, no
// session-manager-plugin) and print it as JSON for the in-process data channel spike.
//
//   node scripts/dev-ssm-start-session.mjs --profile <p> --region <r> --target <i-…> \
//     | (cd ../../services/ssh-core && go run ./cmd/ssm-datachannel-spike -stdin-json)
//
// Optional: --document <name> --parameters '<json>' --reason <text>
// Uses the standard ~/.aws config/credentials for the given profile.
import { SSMClient, StartSessionCommand } from "@aws-sdk/client-ssm";
import { fromIni } from "@aws-sdk/credential-provider-ini";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) {
      continue;
    }
    args[key.slice(2)] = argv[i + 1];
    i += 1;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const { profile, region, target } = args;

if (!profile || !region || !target) {
  console.error(
    "usage: dev-ssm-start-session.mjs --profile <name> --region <region> --target <instance-id>" +
      " [--document <name>] [--parameters <json>] [--reason <text>]",
  );
  process.exit(2);
}

const client = new SSMClient({ region, credentials: fromIni({ profile }) });

try {
  const output = await client.send(
    new StartSessionCommand({
      Target: target,
      ...(args.document ? { DocumentName: args.document } : {}),
      ...(args.parameters ? { Parameters: JSON.parse(args.parameters) } : {}),
      ...(args.reason ? { Reason: args.reason } : {}),
    }),
  );
  console.error(`started session ${output.SessionId} on ${target}`);
  process.stdout.write(
    `${JSON.stringify({
      sessionId: output.SessionId,
      streamUrl: output.StreamUrl,
      tokenValue: output.TokenValue,
    })}\n`,
  );
} catch (error) {
  console.error(`StartSession failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

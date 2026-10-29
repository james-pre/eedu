import { createHash, createHmac } from 'node:crypto';

/** Temporary AWS credentials quiz-api hands out for writing to its streams */
export interface KinesisCredentials {
	access_key_id: string;
	secret_access_key: string;
	session_token: string;
	expiration: string;
}

export interface KinesisConfiguration {
	client_configuration: { endpoint: string | null; region: string };
	credentials: KinesisCredentials;
	stream_identifiers: { events: string; responses: string };
}

export interface KinesisRecord {
	data: string;
	partitionKey: string;
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const hmac = (key: string | Buffer, text: string) => createHmac('sha256', key).update(text).digest();

/** Write records to a stream with Kinesis' PutRecords, signed with AWS Signature Version 4 */
export async function putRecords(configuration: KinesisConfiguration, stream: string, records: KinesisRecord[]): Promise<void> {
	const { region, endpoint } = configuration.client_configuration;
	const { access_key_id, secret_access_key, session_token } = configuration.credentials;
	const url = new URL(endpoint ?? `https://kinesis.${region}.amazonaws.com/`);

	const body = JSON.stringify({
		StreamName: stream,
		Records: records.map(record => ({ Data: Buffer.from(record.data).toString('base64'), PartitionKey: record.partitionKey })),
	});

	const time = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
	const scope = `${time.slice(0, 8)}/${region}/kinesis/aws4_request`;
	const headers: [string, string][] = [
		['content-type', 'application/x-amz-json-1.1'],
		['host', url.host],
		['x-amz-date', time],
		['x-amz-security-token', session_token],
		['x-amz-target', 'Kinesis_20131202.PutRecords'],
	];
	const signed = headers.map(([name]) => name).join(';');
	const canonical = ['POST', url.pathname, '', ...headers.map(([name, value]) => `${name}:${value}`), '', signed, hash(body)].join('\n');

	const key = [time.slice(0, 8), region, 'kinesis', 'aws4_request'].reduce<string | Buffer>(hmac, 'AWS4' + secret_access_key);
	const signature = createHmac('sha256', key)
		.update(['AWS4-HMAC-SHA256', time, scope, hash(canonical)].join('\n'))
		.digest('hex');

	const response = await fetch(url, {
		method: 'POST',
		headers: {
			...Object.fromEntries(headers.filter(([name]) => name != 'host')),
			Authorization: `AWS4-HMAC-SHA256 Credential=${access_key_id}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
		},
		body,
	});

	const json: any = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(`Saving to ${stream} failed: ` + (json.message ?? json.__type ?? response.statusText));
	if (json.FailedRecordCount) throw new Error(`Saving to ${stream} failed: ` + json.Records?.find((r: any) => r.ErrorCode)?.ErrorMessage);
}

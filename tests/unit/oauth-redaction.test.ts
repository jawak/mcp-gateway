import { describe, expect, test } from 'bun:test';
import { REDACTED, redactString, redactValue } from '../../src/lib/server/security/redact';

const UPSTREAM_URL = 'https://mcp.example.test/api/unstable/mcp-server/mcp?toolsets=core';
const REDIRECT_URI = 'https://gateway.example.test/oauth/callback';

describe('OAuth credential shapes', () => {
	const secrets = {
		code: 'AUTH_CODE_SENTINEL_9f3a6c',
		state: 'STATE_SENTINEL_7c1b2d',
		accessToken: 'ACCESS_TOKEN_SENTINEL_4e8f',
		refreshToken: 'REFRESH_TOKEN_SENTINEL_1a2b',
		codeVerifier: 'CODE_VERIFIER_SENTINEL_5d6e'
	};

	test('redacts an authorization code and state in a query string, keeping the keys', () => {
		const input =
			`https://as.example.test/authorize?response_type=code&client_id=public-client` +
			`&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
			`&scope=mcp_all&state=${secrets.state}&code_challenge=abc123&code_challenge_method=S256`;
		const output = redactString(input);

		expect(output).toContain(`state=${REDACTED}`);
		expect(output).not.toContain(secrets.state);
		// public PKCE material is not a credential
		expect(output).toContain('code_challenge=abc123');
		expect(output).toContain('code_challenge_method=S256');
		expect(output).toContain('scope=mcp_all');
		expect(output).toContain(encodeURIComponent(REDIRECT_URI));
	});

	test('redacts a code and code_verifier in a form body', () => {
		const input =
			`grant_type=authorization_code&code=${secrets.code}` +
			`&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
			`&client_id=public-client&code_verifier=${secrets.codeVerifier}`;
		const output = redactString(input);

		expect(output).toContain(`code=${REDACTED}`);
		expect(output).toContain(`code_verifier=${REDACTED}`);
		expect(output).not.toContain(secrets.code);
		expect(output).not.toContain(secrets.codeVerifier);
		// the grant type and redirect URI are safe
		expect(output).toContain('grant_type=authorization_code');
		expect(output).toContain(encodeURIComponent(REDIRECT_URI));
	});

	test('redacts access_token and refresh_token assignments in URL and text form', () => {
		const input =
			`access_token=${secrets.accessToken}&token_type=Bearer&expires_in=3600` +
			`&refresh_token=${secrets.refreshToken}`;
		const output = redactString(input);

		expect(output).toContain(`access_token=${REDACTED}`);
		expect(output).toContain(`refresh_token=${REDACTED}`);
		expect(output).not.toContain(secrets.accessToken);
		expect(output).not.toContain(secrets.refreshToken);
		expect(output).toContain('expires_in=3600');
	});

	test('redacts JSON assignment shapes, keeping the key names visible', () => {
		const input = JSON.stringify({
			access_token: secrets.accessToken,
			refresh_token: secrets.refreshToken,
			code: secrets.code,
			state: secrets.state,
			code_verifier: secrets.codeVerifier,
			token_type: 'Bearer',
			expires_in: 3600,
			scope: 'mcp_all'
		});
		const output = redactString(input);

		for (const key of ['access_token', 'refresh_token', 'code', 'state', 'code_verifier']) {
			expect(output).toMatch(new RegExp(`${key}[=:]\\[redacted\\]`));
		}
		for (const sentinel of Object.values(secrets)) {
			expect(output).not.toContain(sentinel);
		}
		expect(output).toContain('expires_in');
		expect(output).toContain('mcp_all');
	});

	test('redactValue hides OAuth material nested in objects', () => {
		const output = redactValue({
			url: `https://as.example.test/token?code=${secrets.code}&state=${secrets.state}`,
			body: { code_verifier: secrets.codeVerifier, access_token: secrets.accessToken },
			refresh_token: secrets.refreshToken
		}) as Record<string, unknown>;

		const serialized = JSON.stringify(output);
		expect(serialized).toContain(REDACTED);
		for (const sentinel of Object.values(secrets)) {
			expect(serialized).not.toContain(sentinel);
		}
	});
});

describe('OAuth redaction does not hide safe context', () => {
	const safe = [
		'oauthError=access_denied',
		'error=invalid_grant',
		'error_description=The+authorization+grant+is+invalid',
		'scope=mcp_all',
		`redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
		`upstream=${UPSTREAM_URL}`
	];

	for (const input of safe) {
		test(`leaves ${input.split('=')[0]} intact`, () => {
			const output = redactString(input);
			expect(output).toBe(input);
			expect(output).not.toContain(REDACTED);
		});
	}

	test('keeps a safe OAuth error code even when other material is redacted', () => {
		const output = redactString(
			`error=invalid_grant&error_description=bad+code&code=AUTH_CODE_SENTINEL_9f3a6c`
		);
		expect(output).toContain('error=invalid_grant');
		expect(output).toContain(`code=${REDACTED}`);
		expect(output).not.toContain('AUTH_CODE_SENTINEL_9f3a6c');
	});

	test('does not redact an unrelated response_type=code parameter', () => {
		const input = 'response_type=code&client_id=public-client';
		expect(redactString(input)).toBe(input);
	});
});

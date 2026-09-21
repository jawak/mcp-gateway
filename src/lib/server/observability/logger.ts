/**
 * pino logger (T-03 provides the config-driven version; this one is wired so
 * T-02 can log structured lines with a request id).
 *
 * `redact` must never be weakened: master key, bearer tokens and common
 * credential shapes are stripped before anything reaches stdout. The
 * pattern-based scrubbing of tool payloads lives in `security/redact.ts` (T-05).
 */
import pino from 'pino';

export const logger = pino({
	level: process.env.MCPGW_LOG_LEVEL ?? 'info',
	base: { service: process.env.npm_package_name ?? 'mcp-gateway' },
	timestamp: pino.stdTimeFunctions.isoTime,
	formatters: {
		level: (label) => ({ level: label })
	},
	redact: {
		paths: [
			'MCPGW_MASTER_KEY',
			'*.MCPGW_MASTER_KEY',
			'password',
			'*.password',
			'headers.authorization',
			'headers["proxy-authorization"]',
			'req.headers.authorization',
			'*.headers.authorization',
			'apiKey',
			'*.apiKey',
			'key_plain',
			'*.key_plain'
		],
		censor: '[redacted]'
	}
});

export type Logger = typeof logger;

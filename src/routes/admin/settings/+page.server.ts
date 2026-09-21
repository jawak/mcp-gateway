import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	clearOverride,
	effectiveSettings,
	immutableSettings,
	setOverrides
} from '$lib/server/settings';
import { listSecrets } from '$lib/server/governance/secrets';
import { healthzPayload } from '../../../handle';
import { recordAudit } from '$lib/server/observability/audit';
import { createBackup, listBackups, restoreInstructions } from '$lib/server/backup';

/** Numeric overrides, with the label the form shows. Typed so the page never indexes by string. */
const FIELDS = [
	{ field: 'healthIntervalS', label: 'Health check interval (s)' },
	{ field: 'catalogTtlS', label: 'Tool catalog TTL (s)' },
	{ field: 'sessionTtlMin', label: 'MCP session idle (min)' },
	{ field: 'retentionToolCallsDays', label: 'Keep call log (days)' },
	{ field: 'retentionAuditDays', label: 'Keep audit trail (days)' },
	{ field: 'retentionHealthDays', label: 'Keep health history (days)' },
	{ field: 'retentionBackups', label: 'Keep backups (count)' }
] as const;

/** Names an operator may override at runtime (everything else is environment-only). */
const OVERRIDABLE = [
	'healthIntervalS',
	'catalogTtlS',
	'sessionTtlMin',
	'retentionToolCallsDays',
	'retentionAuditDays',
	'retentionHealthDays',
	'retentionBackups',
	'debugPayload'
] as const;

export const load = (() => ({
	effective: effectiveSettings(),
	overridable: OVERRIDABLE,
	fields: FIELDS,
	immutable: immutableSettings(),
	secrets: listSecrets(),
	healthz: healthzPayload(''),
	backups: listBackups(),
	// restore is a documented stop/copy/start procedure, never an in-place swap
	lastRestore: null as { steps: string[]; snapshot: string; target: string } | null
})) satisfies PageServerLoad;

/**
 * Runtime settings.
 *
 * What can change at runtime is limited to how loud and how long the gateway is,
 * never to whether it authenticates: deployment-level values (master key, public
 * URL, bind address, SSRF policy) stay in the environment and are shown read-only.
 * A dashboard that could rewrite its own auth config would turn any XSS into a
 * full compromise of the credential store.
 */
export const actions = {
	save: async ({ request, locals, getClientAddress }) => {
		const data = await request.formData();
		const numeric = (field: string): number | undefined => {
			const raw = String(data.get(field) ?? '').trim();
			if (raw === '') return undefined;
			const value = Number.parseInt(raw, 10);
			return Number.isFinite(value) && value > 0 ? value : undefined;
		};

		const proposed = {
			healthIntervalS: numeric('healthIntervalS'),
			catalogTtlS: numeric('catalogTtlS'),
			sessionTtlMin: numeric('sessionTtlMin'),
			retentionToolCallsDays: numeric('retentionToolCallsDays'),
			retentionAuditDays: numeric('retentionAuditDays'),
			retentionHealthDays: numeric('retentionHealthDays'),
			retentionBackups: numeric('retentionBackups')
		};
		const missing = Object.entries(proposed)
			.filter(([, value]) => value === undefined)
			.map(([key]) => key);
		if (missing.length > 0) {
			return fail(400, {
				error: `Every value must be a positive number (missing: ${missing.join(', ')}).`
			});
		}

		setOverrides({
			...proposed,
			debugPayload: data.get('debugPayload') === 'on'
		});
		recordAudit({
			actorType: 'user',
			actorId: locals.user?.id ?? null,
			action: 'settings.update',
			targetType: 'settings',
			targetId: 'runtime',
			ip: getClientAddress(),
			meta: { ...proposed, debugPayload: data.get('debugPayload') === 'on' }
		});
		throw redirect(303, '/admin/settings?saved=1');
	},

	/** Write a snapshot now (also written daily by the worker). */
	backup: async ({ locals, getClientAddress }) => {
		const snapshot = createBackup();
		recordAudit({
			actorType: 'user',
			actorId: locals.user?.id ?? null,
			action: 'backup.create',
			targetType: 'backup',
			targetId: snapshot.name,
			ip: getClientAddress(),
			meta: { bytes: snapshot.bytes }
		});
		throw redirect(303, '/admin/settings?backuped=1');
	},

	/** Hand back the exact restore commands for one snapshot. */
	restore: async ({ request, locals, getClientAddress }) => {
		const data = await request.formData();
		const name = String(data.get('name') ?? '');
		try {
			const instructions = restoreInstructions(name);
			recordAudit({
				actorType: 'user',
				actorId: locals.user?.id ?? null,
				action: 'backup.restore_instructions',
				targetType: 'backup',
				targetId: name,
				ip: getClientAddress()
			});
			return { restore: instructions, restored: false };
		} catch (error) {
			return fail(400, { error: (error as Error).message });
		}
	},

	reset: async ({ request, locals, getClientAddress }) => {
		const data = await request.formData();
		const field = String(data.get('field') ?? '');
		const allowed = [
			'healthIntervalS',
			'catalogTtlS',
			'sessionTtlMin',
			'retentionToolCallsDays',
			'retentionAuditDays',
			'retentionHealthDays',
			'retentionBackups',
			'debugPayload'
		] as const;
		if (!allowed.includes(field as (typeof allowed)[number])) {
			return fail(400, { error: 'Unknown setting.' });
		}
		clearOverride(field as never);
		recordAudit({
			actorType: 'user',
			actorId: locals.user?.id ?? null,
			action: 'settings.clear_override',
			targetType: 'settings',
			targetId: field,
			ip: getClientAddress()
		});
		throw redirect(303, '/admin/settings?saved=1');
	}
} satisfies Actions;

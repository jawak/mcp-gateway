import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	countActiveAdmins,
	createUser,
	listUsers,
	MIN_PASSWORD_LENGTH,
	resetUserPassword,
	setUserRole,
	setUserStatus
} from '$lib/server/governance/users';
import { RegistryError } from '$lib/server/registry';
import { listActiveSessions } from '$lib/server/governance/adminsession';

export const load = (({ locals }) => ({
	users: listUsers().map((user) => ({
		...user,
		locked: user.lockedUntil !== null && new Date(user.lockedUntil).getTime() > Date.now(),
		isSelf: user.id === locals.user?.id
	})),
	adminCount: countActiveAdmins(),
	sessions: listActiveSessions().length,
	minPassword: MIN_PASSWORD_LENGTH
})) satisfies PageServerLoad;

/**
 * Account management.
 *
 * The guards that matter (last admin, self-demotion, self-disable) live in
 * `governance/users.ts` so they also hold when someone drives the same operations
 * from a script; the form actions here only translate input and surface failures.
 */
export const actions = {
	create: async ({ request, locals, getClientAddress }) => {
		const data = await request.formData();
		try {
			await createUser(
				{
					email: String(data.get('email') ?? ''),
					password: String(data.get('password') ?? ''),
					role: data.get('role') === 'viewer' ? 'viewer' : 'admin'
				},
				{ actorId: locals.user?.id ?? null, ip: getClientAddress() }
			);
		} catch (error) {
			if (error instanceof RegistryError) return fail(400, { error: error.message });
			throw error;
		}
		throw redirect(303, '/admin/users');
	},

	setRole: async ({ request, locals, getClientAddress }) => {
		const data = await request.formData();
		try {
			setUserRole(String(data.get('id')), data.get('role') === 'viewer' ? 'viewer' : 'admin', {
				actorId: locals.user?.id ?? null,
				ip: getClientAddress()
			});
		} catch (error) {
			if (error instanceof RegistryError) return fail(400, { error: error.message });
			throw error;
		}
		throw redirect(303, '/admin/users');
	},

	setStatus: async ({ request, locals, getClientAddress }) => {
		const data = await request.formData();
		try {
			const { sessionsEnded } = setUserStatus(
				String(data.get('id')),
				data.get('status') === 'disabled' ? 'disabled' : 'active',
				{
					actorId: locals.user?.id ?? null,
					ip: getClientAddress()
				}
			);
			throw redirect(303, `/admin/users?ended=${sessionsEnded}`);
		} catch (error) {
			if (error instanceof RegistryError) return fail(400, { error: error.message });
			if (error instanceof Response) throw error;
			throw error;
		}
	},

	resetPassword: async ({ request, locals, getClientAddress }) => {
		const data = await request.formData();
		try {
			await resetUserPassword(String(data.get('id')), String(data.get('password') ?? ''), {
				actorId: locals.user?.id ?? null,
				ip: getClientAddress()
			});
		} catch (error) {
			if (error instanceof RegistryError)
				return fail(400, { error: error.message, targetId: String(data.get('id')) });
			throw error;
		}
		throw redirect(303, '/admin/users?reset=1');
	}
} satisfies Actions;

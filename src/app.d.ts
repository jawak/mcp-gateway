// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
	namespace App {
		interface Locals {
			/** Authenticated dashboard user, or null when the cookie is absent/expired. */
			user: {
				id: string;
				email: string;
				role: 'admin' | 'viewer';
				status: 'active' | 'disabled';
			} | null;
			/** Active web session id, used for logout. */
			sessionId: string | null;
		}
		// interface Error {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};

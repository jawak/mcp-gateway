/**
 * Theme preference, persisted in localStorage.
 *
 * The initial class is applied by an inline script in app.html before first paint,
 * so switching between dark and light never flashes; this store only owns changes
 * made after load.
 */
class Theme {
	value = $state<'light' | 'dark'>('light');

	constructor() {
		if (typeof document !== 'undefined') {
			this.value = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
		}
	}

	toggle(): void {
		this.set(this.value === 'dark' ? 'light' : 'dark');
	}

	set(value: 'light' | 'dark'): void {
		this.value = value;
		if (typeof document === 'undefined') return;
		document.documentElement.classList.toggle('dark', value === 'dark');
		try {
			localStorage.setItem('mcpgw-theme', value);
		} catch {
			// private mode: the toggle still works for this page view
		}
	}
}

export const theme = new Theme();

/** Small checks for what the user types into the wizard. All return an error text, or null when fine. */

const CLIENT_ID_PATTERN = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/i;
export const MIN_PASSPHRASE_LENGTH = 8;

export function checkClientId(value: string): string | null {
	const text = value.trim();
	if (!text) return "Paste the client ID.";
	if (/\s/.test(text)) return "The client ID has no spaces. Copy it again from Google.";
	if (!CLIENT_ID_PATTERN.test(text)) {
		return "A client ID looks like 123456789-abc123.apps.googleusercontent.com. Copy it again from Google.";
	}
	return null;
}

export function checkClientSecret(value: string): string | null {
	const text = value.trim();
	if (!text) return "Paste the client secret.";
	if (/\s/.test(text)) return "The client secret has no spaces. Copy it again from Google.";
	if (text.length < 10) return "That is too short for a client secret. Copy it again from Google.";
	if (CLIENT_ID_PATTERN.test(text)) return "That is the client ID. The secret is the other value (often starting with GOCSPX-).";
	return null;
}

export function checkVaultId(value: string): string | null {
	const text = value.trim();
	if (!text) return "Enter the vault ID.";
	if (/\s/.test(text)) return "The vault ID has no spaces.";
	if (text.length < 8) return "That is too short for a vault ID. Copy it again from the other device.";
	if (text.length > 128) return "That is too long for a vault ID.";
	if (!/^[A-Za-z0-9_-]+$/.test(text)) return "A vault ID uses only letters, digits, - and _.";
	return null;
}

export function checkNewPassphrase(passphrase: string, confirmation: string): string | null {
	if (passphrase.length < MIN_PASSPHRASE_LENGTH) return `Use at least ${MIN_PASSPHRASE_LENGTH} characters.`;
	if (passphrase !== confirmation) return "The two passphrases are different.";
	return null;
}

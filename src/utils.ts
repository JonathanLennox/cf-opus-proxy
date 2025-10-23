export interface ISessionParameters {
	url: URL;
	sessionId: string | null;
	transcribe: boolean;
	connect: string | null;
}

export function extractSessionParameters(url: string): ISessionParameters {
	const parsedUrl = new URL(url);
	const sessionId = parsedUrl.searchParams.get('sessionId');
	const transcribe = parsedUrl.pathname.endsWith('/transcribe');
	const connect = parsedUrl.searchParams.get('connect');

	return {
		url: parsedUrl,
		sessionId,
		transcribe,
		connect,
	};
}

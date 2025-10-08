export interface ISessionParameters {
    url: URL,
    sessionId: string | null;
    tag: string | null;
    transcribe: boolean;
    transcriberType: string;
}

export function extractSessionParameters(url: string): ISessionParameters {
    const parsedUrl = new URL(url);
    const sessionId = parsedUrl.searchParams.get("sessionId");
    const tag = parsedUrl.searchParams.get("tag");
    const type = parsedUrl.searchParams.get("type") ?? "openai";
    const transcribe = parsedUrl.pathname.endsWith("/transcribe");

    return {
        url: parsedUrl,
        sessionId,
        tag,
        transcribe,
        transcriberType: type
    };
}

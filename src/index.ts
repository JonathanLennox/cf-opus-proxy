import { extractSessionParameters } from "./utils";
import { TranscriberProxy } from "./transcriberproxy";

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const upgradeHeader = request.headers.get("Upgrade");

        if (upgradeHeader !== "websocket") {
            return new Response("Worker expected Upgrade: websocket", { status: 426 });
        }

        if (request.method !== "GET") {
            return new Response("Worker expected GET method", { status: 400 });
        }

        const { url, sessionId, transcribe } = extractSessionParameters(request.url);

        if (!url.pathname.endsWith("/events") && !url.pathname.endsWith("/transcribe")) {
            return new Response("Bad URL", { status: 400 });
        }

        if (!sessionId) {
            return new Response("Missing sessionId", { status: 400 });
        }

        if (transcribe) {
            const webSocketPair = new WebSocketPair();
            const [client, server] = Object.values(webSocketPair);

            server.accept();

            // Handle transcription: run the proxy in this worker
            const stub = env.TRANSCRIPTIONATOR.getByName(sessionId);
            const session = new TranscriberProxy(server, env);

            session.on("closed", () => {
                // Notify the Durable Object that the session closed
                stub.notifySessionClosed();
            });

            session.on("message", (data: any) => {
                // Forward transcription messages to the Durable Object for distribution via RPC
                stub.broadcastMessage(data);
            });

            // Accept the connection and return immediately
            return new Response(null, {
                status: 101,
                webSocket: client,
            });
        } else {
            // Handle observer: connect to the Durable Object
            const stub = env.TRANSCRIPTIONATOR.getByName(sessionId);
            return stub.fetch(request);
        }
	},
} satisfies ExportedHandler<Env>;

export { Transcriptionator } from "./transcriptionator"

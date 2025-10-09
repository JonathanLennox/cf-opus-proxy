import { extractSessionParameters } from "./utils";

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

        // Requests from all Workers to the Durable Object instance named "foo"
        // will go to a single remote Durable Object instance.
        const stub = env.TRANSCRIPTIONATOR.getByName(sessionId);

        return stub.fetch(request);
	},
} satisfies ExportedHandler<Env>;

export { Transcriptionator } from "./transcriptionator"

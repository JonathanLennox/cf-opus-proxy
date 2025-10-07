
import { OutgoingConnection } from './OutgoingConnection';

const outgoingConnections = new Map<string, OutgoingConnection>();

function handleMediaEvent(parsedMessage: any, env: any): void {
    const tag = parsedMessage.media?.tag;
	if (tag) {
		if (!outgoingConnections.has(tag)) {
			const connection = new OutgoingConnection(tag, env);
			outgoingConnections.set(tag, connection);
			console.log(`Created outgoing connection entry for tag: ${tag}`);
		}

		const connection = outgoingConnections.get(tag);
		if (connection) {
			connection.handleMediaEvent(parsedMessage);
		}
	}
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		if (request.headers.get('Upgrade') === 'websocket') {
			return handleWebSocket(request, env);
		}
        
        // Dummy for testing
		const conn = new OutgoingConnection('dummy', env);
		conn.handleMediaEvent({event: 'media', media: {tag: 'dummy', payload: ''}});

        console.log("Handled dummy media event");
		return new Response('Not found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;

function handleWebSocket(request: Request, env: any): Response {
	const { 0: client, 1: server } = new WebSocketPair();

	server.accept();

	server.addEventListener('message', async (event) => {
		let parsedMessage;
		try {
			parsedMessage = JSON.parse(event.data as string);
		} catch (parseError) {
			console.error('Failed to parse message as JSON:', parseError);
			parsedMessage = { raw: event.data, parseError: true };
		}

        // TODO: are there any other events that need to be handled?
		if (parsedMessage && parsedMessage.event === 'media') {
		    handleMediaEvent(parsedMessage, env);
		}
	});

	server.addEventListener('close', () => {
		console.log('WebSocket connection closed');
	});

	return new Response(null, {
		status: 101,
		webSocket: client,
	});
}

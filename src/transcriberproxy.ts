import { OutgoingConnection } from './OutgoingConnection';
import { EventEmitter } from 'node:events';

export class TranscriberProxy extends EventEmitter {
    private readonly ws: WebSocket;
    private outgoingConnections: Map<string, OutgoingConnection>;

    // Cloudflare workers allow a max of six concurrent outgoing connections.  Leave some room
    // in case we need to do separate fetch() calls or the like.  The JVB should have at most
    // three concurrent speakers.
    private MAX_OUTGOING_CONNECTIONS = 4

    constructor(ws: WebSocket, env: Env) {
        super()
        this.ws = ws;
        this.outgoingConnections = new Map<string, OutgoingConnection>;

        this.ws.addEventListener('close', () => {
            this.ws.close();
            this.emit("closed");
        })

        this.ws.addEventListener('message', async (event) => {
            let parsedMessage;
            try {
                parsedMessage = JSON.parse(event.data as string);
            } catch (parseError) {
                console.error('Failed to parse message as JSON:', parseError);
                parsedMessage = { raw: event.data, parseError: true };
            }
             // TODO: are there any other events that need to be handled?
             if (parsedMessage && parsedMessage.event === 'media') {
                this.handleMediaEvent(parsedMessage, env);
             }
        });
    }

    handleMediaEvent(parsedMessage: any, env: any): void {
        const tag = parsedMessage.media?.tag;
        if (tag) {
            if (!this.outgoingConnections.has(tag)) {
                while (this.outgoingConnections.size > this.MAX_OUTGOING_CONNECTIONS) {
                    const firstKey = this.outgoingConnections.keys().next().value!
                    this.outgoingConnections.get(firstKey)?.close();
                    this.outgoingConnections.delete(firstKey);
                }

                const connection = new OutgoingConnection(tag, env);

                connection.onCompleteTranscription = (message) => {
                    this.emit("message", message)
                }
                connection.onClosed = (tag) => {
                    this.outgoingConnections.delete(tag)
                }

                this.outgoingConnections.set(tag, connection);
                console.log(`Created outgoing connection entry for tag: ${tag}`);
            }

            const connection = this.outgoingConnections.get(tag);
            if (connection) {
                connection.handleMediaEvent(parsedMessage);
            }
        }
    }
}

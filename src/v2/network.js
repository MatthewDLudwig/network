import { EventServer } from '@nimiq/rpc-events';
import { NanoNetworkApi } from '@nimiq/nano-api';

// Time to wait in seconds before deciding that we are the source node for sure.
// Communication via broadcast channels is incredibly fast, so this number can probably come down a lot.
const PATIENCE_TIME = 3;
function buildFWithLength(len, call = () => {}) {
	const fLengths = [
		() => call(),
		(a) => call(a),
		(a, b) => call(a, b),
		(a, b, c) => call(a, b, c),
		(a, b, c, d) => call(a, b, c, d),
		(a, b, c, d, e) => call(a, b, c, d, e),
		(a, b, c, d, e, f) => call(a, b, c, d, e, f),
		(a, b, c, d, e, f, g) => call(a, b, c, d, e, f, g),
	];
	return fLengths[len];
}
function replaceSource(args, replaceWith = "REPLACE_WITH_WINDOW") {
	let replaced = null;
    args.forEach(it => {
        if (typeof it == "object") {
            Object.entries(it).forEach(entry => {
                if (entry[0] == "_source") {
			replaced = entry[1];
			it[entry[0]] = replaceWith;
                }
            });
        }
    });
	return replaced;
}

export class Network extends NanoNetworkApi {
    /**
     * @param {{cdn: string, network: string}} config
     */
    constructor(config) {
        super(config);
        this._eventServer = new EventServer();
		this._broadcastChannel = new BroadcastChannel("nimiq-rpc");
		this._knowsPlace = false;
		this._sourceNode = true;
		this._needsResponse = { };

		// Define RPC calls.
		const interestingEvents = [
			{
				name : "connect",
				runs : async () => {
					return this.connect();
				}
			}, {
				name : "connectPico",
				runs : async (state, addresses) => {
					return this.connectPico(addresses);
				}
			}, {
				name : "relayTransaction",
				runs : async (state, arg) => {
					return this.relayTransaction(arg);
				}
			}, {
				name : "getTransactionSize",
				runs : async (state, arg) => {
					return this.getTransactionSize(arg);
				}
			}, {
				name : "subscribe",
				runs : async (state, arg) => {
					return this.subscribe(arg);
				}
			}, {
				name : "getBalance",
				runs : async (state, arg) => {
					return this.getBalance(arg);
				}
			}, {
				name : "getAccountTypeString",
				runs : async (state, arg) => {
					return this.getAccountTypeString(arg);
				}
			}, {
				name : "requestTransactionHistory",
				runs : async (state, addresses, knownReceipts, fromHeight) => {
					return this.requestTransactionHistory(addresses, knownReceipts, fromHeight);
				}
			}, {
				name : "requestTransactionReceipts",
				runs : async (state, arg) => {
					return this.requestTransactionReceipts(arg);
				}
			}, {
				name : "getGenesisVestingContracts",
				runs : async (state, arg) => {
					return this.getGenesisVestingContracts(arg);
				}
			}, {
				name : "removeTxFromMempool",
				runs : async (state, arg) => {
					return this.removeTxFromMempool(arg);
				}
			}
		];

		// Register RPC calls.
		interestingEvents.forEach(e => {
			let f = buildFWithLength(e.runs.length, async (...args) => {
				return this.decide(() => {
					return e.runs(...args);
				}, () => {
					return this.requestResponse(e.name, args);
				});
			});

			this._eventServer.onRequest(e.name, f);
		});

		setTimeout(() => {
			if (!this._knowsPlace) {
				this._knowsPlace = true;
				// Had alrady assumed we were the source node.
			}
		}, PATIENCE_TIME * 1000);

		this._broadcastChannel.postMessage("ping");
		this._broadcastChannel.onmessage = (message) => {
			if (typeof message.data == "string") {
				if (message.data == "ping") {
					this.decide(() => {
						message.target.postMessage("pong");
					});
				} else if (message.data == "pong") {
					// We've received a response and now know we are not the source.
					this._knowsPlace = true;
					this._sourceNode = false;
				}
			} else if (typeof message.data == "object" && "type" in message.data && message.data.type == "nimiq-network-request") {
				let requestedEvent = interestingEvents.filter(e => e.name == message.data.request);
				if (requestedEvent.length > 0) {
					replaceSource(message.data.args, window);
					requestedEvent[0].runs(...message.data.args).then(r => {
						replaceSource(message.data.args);
						message.target.postMessage({
							type : "nimiq-network-response",
							request : message.data.request,
							args : message.data.args,
							response : r
						});
					})
				}
			} else if (typeof message.data == "object" && "type" in message.data && message.data.type == "nimiq-network-response") {
				// Only process messages of a type that we are awaiting responses for.
				if (message.data.request in this._needsResponse && this._needsResponse[message.data.request].length > 0) {
					let stillNeedsResponse = [];

					this._needsResponse[message.data.request].forEach(r => {
						// If the response has the same args as the request, resolve that request.
						if (r.args.every((a, i) => i == 0 || a == message.data.args[i])) {
							r.resolve(message.data.response);
						} else {
							stillNeedsResponse.push(r);
						}
					});

					// This pattern felt cleaner than a filter here using the negative of the condition used in if statement in the forEach above.
					this._needsResponse[message.data.request] = stillNeedsResponse;
				}
			}
		}
    }

	requestResponse(method, args) {
		return new Promise((res, rej) => {
			if (!(method in this._needsResponse)) {
				this._needsResponse[method] = [];
			}

			let win = replaceSource(args);

			// Register promise callbacks for when response coems in.
			this._needsResponse[method].push({
				resolve : function (...vals) {
					replaceSource(args, this.win);
					res(...vals);
				},
				reject : function (...vals) {
					replaceSource(args, this.win);
					rej(...vals);
				},
				args : args,
				win : win
			});

			// Request a response from the source node.
			this._broadcastChannel.postMessage({
				type : "nimiq-network-request",
				request : method,
				args : args
			});
		});
	}

	// decides between 3 functions returnign a promise.
	// a - if we know our place and our place is as the source node.
	// b - if we know our place and our place is not as the source (optional, otherwise nothing).
	// c - if we don't know our place (optional, otherwise attempt again in 1 second).
	async decide(a, b, c) {
		if (this._knowsPlace) {
			if (this._sourceNode) {
				return a();
			} else if (b) {
				return b();
			}
		} else {
			if (c) {
				return c();
			} else {
				return new Promise((resolve, reject) => {
					setTimeout(() => {
						// Try again in 1 second resolving if a or b are called, and default for c (trying again in 1 second).
						this.decide(a, b).then(resolve).catch(reject);
					}, 1000);
				});
			}
		}
	}

    fire(event, data) {
        this._eventServer.fire(event, data);
    }

	connect() {
		return this.decide(() => {
			return super.connect();
		}, () => {
			return true;
		});
	}
}

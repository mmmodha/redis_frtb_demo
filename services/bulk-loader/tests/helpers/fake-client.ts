// In-memory PoolClient stand-in. ioredis exposes EventEmitter + status +
// disconnect(); these tests drive state by emitting events explicitly so we
// never open a TCP socket.

import { EventEmitter } from "node:events";
import type { PoolClient } from "../../src/pool.ts";

export class FakeClient extends EventEmitter implements PoolClient {
  status: string = "connecting";
  disconnectCalls = 0;
  disconnect(): void {
    this.disconnectCalls++;
    this.status = "end";
  }
  becomeReady(): void {
    this.status = "ready";
    this.emit("ready");
  }
  drop(): void {
    this.status = "close";
    this.emit("close");
    this.emit("reconnecting");
  }
  goAway(): void {
    this.status = "end";
    this.emit("end");
  }
}

// Wave 5.91 — minimal XMLHttpRequest fake for tests. Lets tests drive
// upload.onprogress / onload / onerror / onabort against the real
// XHR-backed `uploadSource()`.

import { vi } from "vitest";

export class FakeXHR {
  public upload = { onprogress: null as ((ev: ProgressEvent) => void) | null };
  public status = 0;
  public statusText = "";
  public readyState = 0;
  public responseText = "";
  public response: unknown = "";
  public responseType: XMLHttpRequestResponseType = "";
  public onload: ((this: XMLHttpRequest, ev: ProgressEvent) => void) | null = null;
  public onerror: ((this: XMLHttpRequest, ev: ProgressEvent) => void) | null = null;
  public onabort: ((this: XMLHttpRequest, ev: ProgressEvent) => void) | null = null;
  public method = "";
  public url = "";
  public sentBody: BodyInit | null | Document = null;

  static instances: FakeXHR[] = [];
  static resolveSend: ((xhr: FakeXHR) => void) | null = null;

  constructor() { FakeXHR.instances.push(this); }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
    this.readyState = 1;
  }
  setRequestHeader(): void { /* noop */ }
  send(body?: BodyInit | null | Document): void {
    this.sentBody = body ?? null;
    this.readyState = 2;
    FakeXHR.resolveSend?.(this);
    FakeXHR.resolveSend = null;
  }
  abort(): void {
    this.readyState = 4;
    this.onabort?.call(this as unknown as XMLHttpRequest, new ProgressEvent("abort"));
  }

  emitProgress(loaded: number, total: number, lengthComputable = true): void {
    this.upload.onprogress?.(new ProgressEvent("progress", { loaded, total, lengthComputable }));
  }
  complete(status: number, body: string): void {
    this.status = status;
    this.responseText = body;
    this.response = body;
    this.readyState = 4;
    this.onload?.call(this as unknown as XMLHttpRequest, new ProgressEvent("load"));
  }
  fail(): void {
    this.onerror?.call(this as unknown as XMLHttpRequest, new ProgressEvent("error"));
  }
}

export interface XHRHarness {
  waitForSend: () => Promise<FakeXHR>;
  instances: FakeXHR[];
  last: () => FakeXHR;
}

export function installFakeXHR(): XHRHarness {
  FakeXHR.instances = [];
  FakeXHR.resolveSend = null;
  vi.stubGlobal("XMLHttpRequest", FakeXHR as unknown as typeof XMLHttpRequest);
  return {
    instances: FakeXHR.instances,
    last: () => FakeXHR.instances[FakeXHR.instances.length - 1]!,
    waitForSend: () => new Promise<FakeXHR>((resolve) => {
      const existing = FakeXHR.instances.find((x) => x.readyState >= 2);
      if (existing) { resolve(existing); return; }
      FakeXHR.resolveSend = (x) => resolve(x);
    }),
  };
}

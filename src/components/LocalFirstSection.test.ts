import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readLocalFirstStatus,
  type LocalFirstStatus,
} from "@/lib/local-first-status";
import {
  LocalFirstSection,
  LocalFirstView,
  type LocalFirstViewState,
} from "./LocalFirstSection";

const capability: LocalFirstStatus["capability"] = {
  capabilityVersion: 1,
  workspaceBackupAvailable: true,
  unavailableReason: null,
  drive: false,
  installationDrive: { configured: false, operationsAvailable: false },
  accountDrive: { available: false, connected: false },
};

const storageGate: LocalFirstStatus["storageGate"] = {
  required: false,
  satisfied: true,
};

const localStatus: LocalFirstStatus = { capability, storageGate };
const ready = (value: LocalFirstStatus = localStatus): LocalFirstViewState => ({
  kind: "ready",
  value,
});

afterEach(() => vi.unstubAllGlobals());

describe("local-first status reader", () => {
  it("reads the two existing GET contracts with cookies and no cache", async () => {
    const signal = new AbortController().signal;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(capability))
      .mockResolvedValueOnce(Response.json({ storageGate, unlisted: "not shown" }));

    await expect(readLocalFirstStatus(signal, fetcher)).resolves.toEqual(localStatus);
    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/workspace/google/status", {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      signal,
    });
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/config", {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      signal,
    });
  });

  it("fails closed when either status endpoint is unavailable", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ storageGate }));

    await expect(readLocalFirstStatus(new AbortController().signal, fetcher)).rejects.toThrow(
      "Local-first status is unavailable.",
    );
  });

  it("fails closed when a response does not match the server contract", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ drive: true }))
      .mockResolvedValueOnce(Response.json({ storageGate }));

    await expect(readLocalFirstStatus(new AbortController().signal, fetcher)).rejects.toThrow(
      "Local-first status is unavailable.",
    );
  });
});

describe("local-first settings view", () => {
  it("states the local default and the absent Drive credentials plainly", () => {
    const html = renderToStaticMarkup(createElement(LocalFirstView, { state: ready() }));

    expect(html).toContain("Local-first");
    expect(html).toContain("local data directory");
    expect(html).toContain("Google Drive credentials are not configured");
    expect(html).toContain("Local default");
    expect(html).toContain("Not required");
    expect(html).toContain("does not report a last-sync time");
    expect(html).not.toContain("refreshToken");
  });

  it("reports a connected account and an open storage gate without claiming activity", () => {
    const connected: LocalFirstStatus = {
      ...localStatus,
      capability: {
        ...capability,
        accountDrive: { available: true, connected: true },
      },
      storageGate: { required: true, satisfied: false },
    };
    const html = renderToStaticMarkup(createElement(LocalFirstView, { state: ready(connected) }));

    expect(html).toContain("This account has a Drive connection");
    expect(html).toContain("Connected");
    expect(html).toContain("Needs connection");
    expect(html).toContain("Drive or Telegram storage connection");
  });

  it("does not turn loading or an error into a connection claim", () => {
    const loading = renderToStaticMarkup(createElement(LocalFirstView, { state: { kind: "loading" } }));
    expect(loading).toContain("Checking Drive connection and sync readiness");
    expect(loading).toContain("does not report a last-sync time");
    expect(loading).not.toContain("This account has a Drive connection");

    const error = renderToStaticMarkup(createElement(LocalFirstView, { state: { kind: "error" } }));
    expect(error).toContain("Drive status could not be confirmed");
    expect(error).toContain("No connection or sync activity is being assumed");
    expect(error).not.toContain("This account has a Drive connection");
  });

  it("does not start a read during server rendering", () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);

    const html = renderToStaticMarkup(createElement(LocalFirstSection));

    expect(html).toContain("Checking Drive connection and sync readiness");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

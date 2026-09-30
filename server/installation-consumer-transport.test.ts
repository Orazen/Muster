/** Real loopback HTTP checks for the credential consumer. These servers own
 * no user state; a redirect must never be another credential destination. */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { InstallationConsumer, loadPersistedInstallation, installationConsumerPath } from "./installation-consumer.ts";

const NOW = 1_789_000_000_000;
const directories: string[] = [];
const servers: Server[] = [];
const installation = {
  id: "owned-loopback-installation", label: "Owned fixture", platform: "macos",
  capabilities: ["workspace"], createdAt: NOW, lastSeenAt: NOW, revokedAt: null,
};
const registration = {
  installation, credential: "fixture-only-secret", credentialExpiresAt: NOW + 7_200_000, reactivated: false,
};

async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const address = z.object({ port: z.number().int().min(1).max(65_535) }).parse(server.address());
  return `http://127.0.0.1:${address.port}`;
}

function directory() {
  const path = mkdtempSync(join(tmpdir(), "muster-installation-transport-"));
  directories.push(path);
  return path;
}

function attach(consumer: InstallationConsumer) {
  return consumer.registerThroughOwner("fixture-session=owned", {
    clientKey: consumer.clientKey, label: "Owned fixture", platform: "macos",
  }, NOW);
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("installation credential transport", () => {
  it.each(["register", "self", "refresh"])("refuses a redirect from /%s without contacting its destination", async route => {
    let destinationRequests = 0;
    const destination = await listen((_request, response) => {
      destinationRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ...registration, credentialExpiresAt: NOW + 14_400_000 }));
    });
    const origin = await listen((request, response) => {
      if (request.url === `/api/installations/${route}`) {
        response.writeHead(307, { location: `${destination}/capture` });
        response.end();
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(registration));
      }
    });
    const consumer = new InstallationConsumer({ dataDirectory: directory(), baseUrl: origin }, NOW);
    if (route !== "register") await attach(consumer);
    const operation = route === "register" ? attach(consumer)
      : route === "self" ? consumer.heartbeat(NOW) : consumer.refreshCredential(NOW);
    const [result] = await Promise.allSettled([operation]);
    expect(result?.status).toBe("rejected");
    expect(destinationRequests).toBe(0);
  });

  it("uses the canonical authority for requests and saves that same authority", async () => {
    const paths: string[] = [];
    const origin = await listen((request, response) => {
      paths.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(registration));
    });
    const dataDirectory = directory();
    const consumer = new InstallationConsumer({ dataDirectory, baseUrl: `${origin}/accidental-prefix?ignored=1#fragment` }, NOW);
    await attach(consumer);
    expect(paths).toEqual(["/api/installations/register"]);
    expect(loadPersistedInstallation(installationConsumerPath(dataDirectory), origin)?.authority).toBe(origin);
  });

  it.each(["not-an-origin", "file:///private/fixture", "https://user:password@fixture.test", "http://untrusted.fixture.test"])("rejects an unsuitable authority before any request: %s", baseUrl => {
    let requests = 0;
    expect(() => new InstallationConsumer({
      dataDirectory: directory(), baseUrl,
      fetchJson: async () => { requests += 1; return new Response(null, { status: 500 }); },
    }, NOW)).toThrow();
    expect(requests).toBe(0);
  });

  it("bounds an incomplete credential response body instead of waiting indefinitely", async () => {
    const origin = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"installation":');
      // Deliberately never end the body. afterEach closes this owned socket.
    });
    const consumer = new InstallationConsumer({ dataDirectory: directory(), baseUrl: origin }, NOW);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        attach(consumer).then(() => "accepted", () => "refused"),
        new Promise<string>(resolve => { deadline = setTimeout(() => resolve("still-pending"), 17_000); }),
      ]);
      expect(result).toBe("refused");
      expect(consumer.status).not.toBe("active");
    } finally {
      clearTimeout(deadline);
    }
  }, 20_000);
});

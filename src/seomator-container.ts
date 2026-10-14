import { Container } from "@cloudflare/containers";

/**
 * Durable Object class backing the SEOmator audit container.
 *
 * Cloudflare Containers (beta) requires every container to be linked to a DO
 * class via `containers.class_name` in wrangler.toml. Requests fetch()'d to a
 * stub of this class are proxied to the container's default port (3000), where
 * container-seomator/server.js listens on POST /audit.
 *
 * idFromName("seomator") yields a single global instance, so audits are
 * serialized through one container (matches max_instances = 1).
 */
export class SeomatorContainer extends Container {
  defaultPort = 3000;
  // Keep the container warm for 15 minutes after the last request to avoid
  // repeated cold starts (~3-5s) during burst usage.
  sleepAfter = "15m";
}

/** Minimal structural type for the DO namespace binding in the Worker Env. */
export interface SeomatorContainerNamespace {
  idFromName(name: string): { toString(): string };
  get(id: { toString(): string }): { fetch(url: string, init?: RequestInit): Promise<Response> };
}

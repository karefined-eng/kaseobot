/**
 * Vitest stub for the Workers-runtime-only "cloudflare:workers" module.
 *
 * @cloudflare/containers imports DurableObject and WorkerEntrypoint from
 * "cloudflare:workers", which only exists inside the workerd runtime. Tests
 * never instantiate the container class; they only import the module graph,
 * so inert base classes are sufficient.
 */
export class DurableObject {}
export class WorkerEntrypoint {}
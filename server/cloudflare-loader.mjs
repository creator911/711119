const workersModule = new URL("./cloudflare-workers.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return { url: workersModule, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

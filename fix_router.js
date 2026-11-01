import fs from 'fs';

let content = fs.readFileSync('src/router/router.ts', 'utf-8');

content = content.replace(
  `    const route = this.config.routes[request.taskClass];
    let provider = this.providers.get(route.defaultProvider);
    let modelName = route.defaultModel;

    if (!provider && route.fallbackProvider) {
      provider = this.providers.get(route.fallbackProvider);
      modelName = route.fallbackModel || "default";
    }

    if (!provider) {
      throw new Error(\`No provider registered for \${route.defaultProvider} (taskClass: \${request.taskClass})\`);
    }

    const response = await provider.complete(request, modelName);`,
  `    const route = this.config.routes[request.taskClass];
    let response: ModelCompletionResponse | null = null;
    let lastError: any = null;

    for (const entry of route.chain) {
      const provider = this.providers.get(entry.provider);
      if (!provider) {
        lastError = new Error(\`Provider "\${entry.provider}" not registered.\`);
        continue;
      }

      try {
        response = await provider.complete(request, entry.model);
        break; // Success, exit chain
      } catch (err: any) {
        lastError = err;
        // Continue to the next provider in the chain if there's an error (e.g., 404, 410, or generic throw)
      }
    }

    if (!response) {
      throw new Error(\`All providers in chain for taskClass "\${request.taskClass}" failed. Last error: \${lastError?.message || "Unknown"}\`);
    }`
);

fs.writeFileSync('src/router/router.ts', content);

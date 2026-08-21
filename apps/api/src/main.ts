import { buildApp } from './app';

const app = await buildApp();

try {
  await app.listen({ port: app.cfg.PORT, host: app.cfg.HOST });
  app.log.info(`Lotmark API on http://${app.cfg.HOST}:${app.cfg.PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    app.log.info(`${signal} received, closing`);
    await app.close();
    process.exit(0);
  });
}

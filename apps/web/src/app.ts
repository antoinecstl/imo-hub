import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '@imo/db';
import { fieldCompleteness, getListing, listListings, ListingsQuery, listRuns, listSources } from './queries.ts';
import { renderListingPage, renderTechnicalPage } from './pages.ts';

const Uuid = z.string().uuid();

export function buildApp(db: Db): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' && !process.env.VITEST });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.status(400).send({ error: 'paramètres invalides', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    app.log.error(err);
    return reply.status(500).send({ error: 'erreur interne' });
  });

  app.get('/api/health', async () => {
    await db.query('SELECT 1');
    return { ok: true };
  });

  app.get('/api/listings', async (req) => listListings(db, ListingsQuery.parse(req.query)));

  app.get('/api/listings/:id', async (req, reply) => {
    const id = Uuid.safeParse((req.params as { id: string }).id);
    const listing = id.success ? await getListing(db, id.data) : null;
    return listing ?? reply.status(404).send({ error: 'annonce introuvable' });
  });

  app.get('/api/sources', async () => ({ items: await listSources(db) }));

  app.get('/api/runs', async (req) => {
    const q = z.object({ source: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(50) }).parse(req.query);
    return { items: await listRuns(db, q) };
  });

  app.get('/api/quality/completeness', async () => ({ items: await fieldCompleteness(db) }));

  // Page technique : état des sources, dernières collectes, complétude et annonces.
  app.get('/', async (req, reply) => {
    const q = ListingsQuery.parse(req.query);
    const [sources, runs, completeness, listings] = await Promise.all([
      listSources(db), listRuns(db, { limit: 20 }), fieldCompleteness(db), listListings(db, q),
    ]);
    return reply.type('text/html; charset=utf-8').send(renderTechnicalPage({ sources, runs, completeness, listings, query: req.query as Record<string, string> }));
  });

  app.get('/listings/:id', async (req, reply) => {
    const id = Uuid.safeParse((req.params as { id: string }).id);
    const listing = id.success ? await getListing(db, id.data) : null;
    if (!listing) return reply.status(404).type('text/html; charset=utf-8').send('<p>Annonce introuvable</p>');
    return reply.type('text/html; charset=utf-8').send(renderListingPage(listing));
  });

  return app;
}

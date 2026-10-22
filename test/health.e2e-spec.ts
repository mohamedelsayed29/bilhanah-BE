import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from './test-app.js';

// Requires the local services: `npm run services:up` from the repository root.
describe('Health and HTTP conventions (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health reports liveness outside the /v1 prefix', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('GET /health/ready confirms PostgreSQL and Redis', async () => {
    const response = await request(app.getHttpServer()).get('/health/ready').expect(200);
    expect(response.body).toEqual({ status: 'ok', checks: { database: 'up', redis: 'up' } });
  });

  it('echoes a well-formed request ID and replaces a malformed one', async () => {
    const kept = await request(app.getHttpServer()).get('/health').set('x-request-id', 'req-12345678');
    expect(kept.headers['x-request-id']).toBe('req-12345678');

    const replaced = await request(app.getHttpServer()).get('/health').set('x-request-id', 'bad id!');
    expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('allows credentialed CORS only for dashboard origins', async () => {
    const allowed = await request(app.getHttpServer())
      .options('/v1/auth/login')
      .set('Origin', 'http://dashboard.test')
      .set('Access-Control-Request-Method', 'POST');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://dashboard.test');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');

    const denied = await request(app.getHttpServer())
      .options('/v1/auth/login')
      .set('Origin', 'https://evil.test')
      .set('Access-Control-Request-Method', 'POST');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('lets any restaurant subdomain read public endpoints without credentials', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/public/restaurants/nobody-here')
      .set('Origin', 'https://koshary.bilhanah.test');
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('rejects malformed JSON with the standard validation error', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/auth/forgot-password')
      .set('Content-Type', 'application/json')
      .send('{"email":')
      .expect(400);
    expect(response.body.error).toEqual({
      code: 'VALIDATION_FAILED',
      message: 'The request body is not valid JSON.',
      requestId: expect.any(String),
    });
    expect(response.headers['x-request-id']).toBe(response.body.error.requestId);
  });

  it('rejects oversized bodies with 413', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/auth/forgot-password')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ email: 'a'.repeat(200_000) }))
      .expect(413);
    expect(response.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('returns the standard error shape for unknown routes', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/does-not-exist')
      .set('x-request-id', 'req-abcdefgh')
      .expect(404);
    expect(response.body).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Cannot GET /v1/does-not-exist',
        requestId: 'req-abcdefgh',
      },
    });
  });
});

# NestJS Backend

Planned stack: Node.js, NestJS, TypeScript, PostgreSQL, Prisma, Redis, BullMQ, and Socket.IO.

| Directory | Responsibility |
| --- | --- |
| `src/config` | Validated environment configuration |
| `src/common` | Shared guards, decorators, filters, interceptors, and pipes |
| `src/infrastructure` | Database, Redis, queue, storage, email, and monitoring adapters |
| `src/modules` | Business modules organized by responsibility |
| `src/commands` | Controlled administrator bootstrap and maintenance commands |
| `test` | Database-backed integration and API tests |

The HTTP API and background worker will use separate entry points in this application and share NestJS modules. The worker is not a fourth application or a separate microservice.

A business module can contain its module definition, controllers, services, scoped repository, policies, events, and colocated unit tests. Create these files when implementing the corresponding feature; empty TypeScript stubs are intentionally not generated.

Database schema and migrations belong in `packages/database`. Request/response contracts belong in `packages/contracts`. Never expose Prisma models or secrets directly to frontend clients.

This is a directory skeleton, not an initialized NestJS application.

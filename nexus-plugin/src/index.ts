import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import path from 'path';

import { loadConfig } from './config';
import { DatabaseService } from './database/database.service';
import { initializeRedis } from './database/redis.service';
import { NexusAuthClient } from './auth/nexus-auth-client';
import { setupSocketServer } from './websocket/socket-server';
import { RunStreamManager } from './websocket/run-stream';
import { createRateLimiter, rateLimiter } from './middleware/rate-limiter';
import { requireAuth } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { requestLogger } from './middleware/request-logger';
import { usageTracker } from './middleware/usage-tracker';
import { QuotaEnforcer } from './middleware/quota-enforcer';
import { HealthChecker } from './utils/health-checker';
import { createLogger } from './utils/logger';
import { register as metricsRegistry, httpRequestDuration, httpRequestTotal } from './utils/metrics';

// Import route factories (actual export names are *Router, not *Routes)
import { createProjectRouter } from './api/projects';
import { createTaskRouter } from './api/tasks';
import { createRunRouter } from './api/runs';
import { createScheduleRouter } from './api/schedules';
import { createWaitpointRouter } from './api/waitpoints';
import { createEnvironmentRouter } from './api/environments';
import { createDeploymentRouter } from './api/deployments';
import { createQueueRouter } from './api/queues';
import { createIntegrationRouter } from './api/integrations';

// Import services
import { TriggerProxyService } from './services/trigger-proxy.service';
import { ProjectService } from './services/project.service';
import { TaskService } from './services/task.service';
import { RunService } from './services/run.service';
import { ScheduleService } from './services/schedule.service';
import { WaitpointService } from './services/waitpoint.service';
import { DeploymentService } from './services/deployment.service';
import { QueueService } from './services/queue.service';
import { SyncService } from './services/sync.service';

// Import repositories
import { ProjectRepository } from './database/repositories/project.repository';
import { RunRepository } from './database/repositories/run.repository';
import { ScheduleRepository } from './database/repositories/schedule.repository';
import { WaitpointRepository } from './database/repositories/waitpoint.repository';
import { IntegrationConfigRepository } from './database/repositories/integration-config.repository';
import { WebhookRepository } from './database/repositories/webhook.repository';
import { UsageRepository } from './database/repositories/usage.repository';
import { TaskDefinitionRepository } from './database/repositories/task-definition.repository';
import { TaskTemplateRepository } from './database/repositories/task-template.repository';

// Import Trigger.dev client factory
import { createTriggerClients } from './config/trigger-client';

// Import integration clients
import { GraphRAGClient } from './integrations/graphrag.client';

const logger = createLogger({ service: 'nexus-trigger', component: 'server' });

class NexusTriggerServer {
  private app: express.Application;
  private server: http.Server;
  private io: SocketIOServer;
  private db: DatabaseService;
  private redis: any;
  private authClient: NexusAuthClient;
  private healthChecker: HealthChecker;
  private runStreamManager: RunStreamManager;
  private syncService: SyncService;
  private config: ReturnType<typeof loadConfig>;

  constructor() {
    this.config = loadConfig();
    this.app = express();
    this.server = http.createServer(this.app);

    // Initialize Socket.IO
    this.io = new SocketIOServer(this.server, {
      path: '/trigger/ws',
      cors: {
        origin: '*',
        credentials: true,
      },
      pingInterval: 25000,
      pingTimeout: 60000,
      maxHttpBufferSize: 1e6, // 1MB
    });

    // Initialize database (pass DatabaseConfig directly)
    this.db = new DatabaseService(this.config.database);

    // Initialize Redis
    this.redis = initializeRedis(this.config.redis.url);

    // Initialize auth client
    this.authClient = new NexusAuthClient(
      this.config.nexus.authUrl,
      this.config.nexus.apiKey
    );
    this.authClient.setRedis(this.redis);

    // Initialize health checker (takes version string only)
    this.healthChecker = new HealthChecker(this.config.plugin.version);

    // Initialize run stream manager
    this.runStreamManager = new RunStreamManager(this.io, {
      triggerApiUrl: this.config.trigger.apiUrl,
      triggerSecretKey: this.config.trigger.secretKey,
      pollIntervalMs: 3000,
    });

    // Initialize sync service (placeholder - will be fully wired in start())
    this.syncService = null as any;
  }

  async start(): Promise<void> {
    try {
      // Connect to database
      await this.db.connect();
      logger.info('Database connected');

      // Test Redis connection
      await this.redis.ping();
      logger.info('Redis connected');

      // Initialize repositories
      const projectRepo = new ProjectRepository(this.db);
      const runRepo = new RunRepository(this.db);
      const scheduleRepo = new ScheduleRepository(this.db);
      const waitpointRepo = new WaitpointRepository(this.db);
      const integrationConfigRepo = new IntegrationConfigRepository(this.db);
      const webhookRepo = new WebhookRepository(this.db);
      const usageRepo = new UsageRepository(this.db);
      const taskDefRepo = new TaskDefinitionRepository(this.db);
      const taskTemplateRepo = new TaskTemplateRepository(this.db);

      // Initialize Trigger.dev SDK and Management API client
      const triggerClients = createTriggerClients(this.config.trigger);

      // Initialize Trigger.dev proxy service
      const triggerProxy = new TriggerProxyService(triggerClients.managementApi);

      // Initialize integration clients
      const graphragClient = new GraphRAGClient('system');

      // Initialize services (match actual constructor signatures)
      const projectService = new ProjectService(projectRepo, usageRepo);
      const taskService = new TaskService(
        triggerProxy,
        projectRepo,
        runRepo,
        taskDefRepo,
        usageRepo,
        this.config.nexus,
        this.io,
        this.runStreamManager
      );
      const runService = new RunService(triggerProxy, runRepo, this.io);
      const scheduleService = new ScheduleService(triggerProxy, scheduleRepo, usageRepo, this.io);
      const waitpointService = new WaitpointService(triggerProxy, waitpointRepo, usageRepo, this.io);
      const deploymentService = new DeploymentService(triggerProxy, this.db);
      const queueService = new QueueService(triggerProxy, this.io);
      this.syncService = new SyncService(triggerProxy, runRepo, scheduleRepo);

      // Setup middleware
      this.setupMiddleware();

      // Setup health endpoints (no auth required)
      this.setupHealthEndpoints();

      // Setup metrics endpoint
      this.setupMetricsEndpoint();

      // Setup API routes (auth required)
      this.setupApiRoutes(
        triggerProxy,
        projectService,
        taskService,
        runService,
        scheduleService,
        waitpointService,
        deploymentService,
        queueService,
        integrationConfigRepo,
        taskTemplateRepo
      );

      // Serve UI static files
      this.setupUI();

      // Error handling
      this.app.use(notFoundHandler);
      this.app.use(errorHandler);

      // Setup WebSocket
      setupSocketServer(this.io, this.authClient, this.redis);

      // Start run stream manager
      this.runStreamManager.start();

      // Start periodic sync (every 30 seconds)
      this.syncService.startPeriodicSync(30000);

      // Start server
      const port = this.config.plugin.port;
      this.server.listen(port, () => {
        logger.info(`Nexus Trigger plugin server started`, {
          port,
          mode: this.config.trigger.mode,
          triggerApiUrl: this.config.trigger.apiUrl,
          environment: this.config.trigger.environment,
          nodeEnv: process.env.NODE_ENV,
        });
      });

      // Graceful shutdown
      this.setupGracefulShutdown();
    } catch (err: any) {
      logger.error('Failed to start server', { error: err.message, stack: err.stack });
      process.exit(1);
    }
  }

  private setupMiddleware(): void {
    // Security headers
    this.app.use(
      helmet({
        contentSecurityPolicy: false, // Allow UI to load
        crossOriginEmbedderPolicy: false,
      })
    );

    // CORS
    this.app.use(
      cors({
        origin: '*',
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-Organization-ID'],
      })
    );

    // Compression
    this.app.use(compression());

    // Body parsing
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Request logging
    this.app.use(requestLogger);

    // Request timing metrics
    this.app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        const duration = (Date.now() - start) / 1000;
        const route = req.route?.path || req.path;
        httpRequestDuration.observe(
          { method: req.method, route, status_code: String(res.statusCode) },
          duration
        );
        httpRequestTotal.inc({
          method: req.method,
          route,
          status_code: String(res.statusCode),
        });
      });
      next();
    });
  }

  private setupHealthEndpoints(): void {
    // Root health endpoint (K8s liveness probe — only check critical internal deps)
    this.app.get('/health', async (_req, res) => {
      try {
        const health = await this.healthChecker.performHealthCheck({
          pool: this.db.getPool(),
          redis: this.redis,
          // Do NOT check triggerApiUrl here — it's an external dependency
          // and its absence should not cause pod restarts.
          // Use /trigger/health for the full diagnostic check.
          memoryThreshold: 98, // Lenient threshold for liveness
        });
        // For liveness: return 200 for healthy/degraded, 503 only for unhealthy
        const statusCode = health.status === 'unhealthy' ? 503 : 200;
        res.status(statusCode).json(health);
      } catch (err: any) {
        res.status(503).json({ status: 'unhealthy', error: err.message });
      }
    });

    this.app.get('/ready', async (_req, res) => {
      try {
        const dbHealth = await this.db.healthCheck();
        if (!dbHealth.healthy) {
          return res.status(503).json({ status: 'not_ready', reason: 'Database unavailable' });
        }
        res.json({ status: 'ready' });
      } catch (err: any) {
        res.status(503).json({ status: 'not_ready', reason: err.message });
      }
    });

    // Liveness probe - is the process alive?
    this.app.get('/trigger/live', (_req, res) => {
      res.json({
        status: 'alive',
        service: 'nexus-trigger',
        version: this.config.plugin.version,
        uptime: process.uptime(),
      });
    });

    // Readiness probe - can we serve traffic?
    this.app.get('/trigger/ready', async (_req, res) => {
      try {
        const dbHealth = await this.db.healthCheck();
        if (!dbHealth.healthy) {
          return res.status(503).json({
            status: 'not_ready',
            reason: 'Database unavailable',
          });
        }
        res.json({ status: 'ready' });
      } catch (err: any) {
        res.status(503).json({
          status: 'not_ready',
          reason: err.message,
        });
      }
    });

    // Health check - detailed system status
    this.app.get('/trigger/health', async (_req, res) => {
      try {
        const health = await this.healthChecker.performHealthCheck({
          pool: this.db.getPool(),
          redis: this.redis,
          triggerApiUrl: this.config.trigger.apiUrl,
        });
        const statusCode = health.status === 'healthy' ? 200 : health.status === 'degraded' ? 200 : 503;
        res.status(statusCode).json(health);
      } catch (err: any) {
        res.status(503).json({
          status: 'unhealthy',
          error: err.message,
        });
      }
    });
  }

  private setupMetricsEndpoint(): void {
    this.app.get('/trigger/metrics', async (_req, res) => {
      try {
        res.set('Content-Type', metricsRegistry.contentType);
        const metrics = await metricsRegistry.metrics();
        res.end(metrics);
      } catch (err: any) {
        res.status(500).end(err.message);
      }
    });
  }

  private setupApiRoutes(
    triggerProxy: TriggerProxyService,
    projectService: ProjectService,
    taskService: TaskService,
    runService: RunService,
    scheduleService: ScheduleService,
    waitpointService: WaitpointService,
    deploymentService: DeploymentService,
    queueService: QueueService,
    integrationConfigRepo: IntegrationConfigRepository,
    taskTemplateRepo: TaskTemplateRepository
  ): void {
    const apiRouter = express.Router();

    // Apply auth middleware to all API routes
    const limiters = createRateLimiter(this.redis);
    const quotaEnforcer = new QuotaEnforcer(this.redis);
    const usageTrackerMiddleware = usageTracker(this.db.getPool());

    apiRouter.use(requireAuth(this.authClient));
    apiRouter.use(rateLimiter(limiters));
    apiRouter.use(usageTrackerMiddleware);

    // Mount route modules (match actual function signatures)
    apiRouter.use('/projects', createProjectRouter(projectService, this.io));
    apiRouter.use('/tasks', createTaskRouter(taskService, this.io));
    apiRouter.use('/runs', createRunRouter(runService, this.io));
    apiRouter.use('/schedules', createScheduleRouter(scheduleService, this.io));
    apiRouter.use('/waitpoints', createWaitpointRouter(waitpointService, this.io));
    apiRouter.use('/environments', createEnvironmentRouter(triggerProxy));
    apiRouter.use('/deployments', createDeploymentRouter(deploymentService));
    apiRouter.use('/queues', createQueueRouter(queueService, this.io));
    apiRouter.use('/integrations', createIntegrationRouter(integrationConfigRepo, this.config.nexus, this.io, taskTemplateRepo));

    this.app.use('/trigger/api/v1', apiRouter);

    logger.info('API routes mounted at /trigger/api/v1');
  }

  private setupUI(): void {
    const uiBuildPath = path.resolve(this.config.plugin.uiBuildPath || './ui/out');

    // Root redirect for proxy access
    this.app.get('/', (_req, res) => res.redirect('/trigger/ui'));

    // Serve Next.js static export
    this.app.use('/trigger/ui', express.static(uiBuildPath));

    // SPA fallback - serve index.html for client-side routing
    this.app.get('/trigger/ui/*', (_req, res) => {
      res.sendFile(path.join(uiBuildPath, 'index.html'), (err) => {
        if (err) {
          res.status(404).json({ error: 'UI not found. Build the UI first: cd ui && npm run build' });
        }
      });
    });

    logger.info('UI served from', { path: uiBuildPath });
  }

  private setupGracefulShutdown(): void {
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, starting graceful shutdown...`);

      // Stop accepting new connections
      this.server.close(() => {
        logger.info('HTTP server closed');
      });

      // Stop run stream manager
      this.runStreamManager.stop();

      // Stop periodic sync
      if (this.syncService) {
        this.syncService.stopPeriodicSync();
      }

      // Close WebSocket connections
      this.io.close(() => {
        logger.info('WebSocket server closed');
      });

      // Disconnect from services
      try {
        await this.db.disconnect();
        logger.info('Database disconnected');
      } catch (err: any) {
        logger.error('Error disconnecting database', { error: err.message });
      }

      try {
        this.redis.disconnect();
        logger.info('Redis disconnected');
      } catch (err: any) {
        logger.error('Error disconnecting Redis', { error: err.message });
      }

      logger.info('Graceful shutdown complete');
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    process.on('uncaughtException', (err) => {
      logger.error('Uncaught exception', { error: err.message, stack: err.stack });
      shutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason: any) => {
      logger.error('Unhandled rejection', { reason: reason?.message || String(reason) });
    });
  }
}

// Start server
const server = new NexusTriggerServer();
server.start().catch((err) => {
  console.error('Fatal error starting Nexus Trigger plugin:', err);
  process.exit(1);
});

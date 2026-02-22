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
import { setupSocketServer, getSocketStats } from './websocket/socket-server';
import { RunStreamManager } from './websocket/run-stream';
import { createRateLimiter } from './middleware/rate-limiter';
import { requireAuth } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { requestLogger } from './middleware/request-logger';
import { usageTracker } from './middleware/usage-tracker';
import { QuotaEnforcer } from './middleware/quota-enforcer';
import { HealthChecker } from './utils/health-checker';
import { createLogger } from './utils/logger';
import { register as metricsRegistry, httpRequestDuration, httpRequestTotal } from './utils/metrics';

// Import route factories
import { createProjectRoutes } from './api/projects';
import { createTaskRoutes } from './api/tasks';
import { createRunRoutes } from './api/runs';
import { createScheduleRoutes } from './api/schedules';
import { createWaitpointRoutes } from './api/waitpoints';
import { createEnvironmentRoutes } from './api/environments';
import { createDeploymentRoutes } from './api/deployments';
import { createQueueRoutes } from './api/queues';
import { createIntegrationRoutes } from './api/integrations';

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

    // Initialize database
    this.db = new DatabaseService({
      host: this.config.database.host,
      port: this.config.database.port,
      database: this.config.database.database,
      user: this.config.database.user,
      password: this.config.database.password,
      ssl: this.config.database.ssl,
      max: this.config.database.maxConnections,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    // Initialize Redis
    this.redis = initializeRedis(this.config.redis.url);

    // Initialize auth client
    this.authClient = new NexusAuthClient(
      this.config.nexus.authUrl,
      this.redis
    );

    // Initialize health checker
    this.healthChecker = new HealthChecker(
      this.db,
      this.redis,
      this.config.trigger.apiUrl
    );

    // Initialize run stream manager
    this.runStreamManager = new RunStreamManager(this.io, {
      triggerApiUrl: this.config.trigger.apiUrl,
      triggerSecretKey: this.config.trigger.secretKey,
      pollIntervalMs: 3000,
    });

    // Initialize sync service (placeholder - will be fully wired in services)
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

      // Initialize Trigger.dev proxy service
      const triggerProxy = new TriggerProxyService(this.config.trigger);

      // Initialize integration clients
      const graphragClient = new GraphRAGClient();

      // Initialize services
      const projectService = new ProjectService(projectRepo, triggerProxy);
      const taskService = new TaskService(
        this.db,
        triggerProxy,
        runRepo,
        graphragClient,
        this.runStreamManager,
        this.io
      );
      const runService = new RunService(runRepo, triggerProxy, this.io);
      const scheduleService = new ScheduleService(scheduleRepo, triggerProxy, this.io);
      const waitpointService = new WaitpointService(waitpointRepo, triggerProxy, this.io);
      const deploymentService = new DeploymentService(triggerProxy);
      const queueService = new QueueService(triggerProxy, this.io);
      this.syncService = new SyncService(
        runRepo,
        scheduleRepo,
        triggerProxy,
        this.db
      );

      // Setup middleware
      this.setupMiddleware();

      // Setup health endpoints (no auth required)
      this.setupHealthEndpoints();

      // Setup metrics endpoint
      this.setupMetricsEndpoint();

      // Setup API routes (auth required)
      this.setupApiRoutes(
        projectService,
        taskService,
        runService,
        scheduleService,
        waitpointService,
        deploymentService,
        queueService,
        integrationConfigRepo
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
        if (dbHealth.status === 'unhealthy') {
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
        const health = await this.healthChecker.check();
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
    projectService: ProjectService,
    taskService: TaskService,
    runService: RunService,
    scheduleService: ScheduleService,
    waitpointService: WaitpointService,
    deploymentService: DeploymentService,
    queueService: QueueService,
    integrationConfigRepo: IntegrationConfigRepository
  ): void {
    const apiRouter = express.Router();

    // Apply auth middleware to all API routes
    const rateLimiter = createRateLimiter(this.redis);
    const quotaEnforcer = new QuotaEnforcer(this.redis);
    const usageTrackerMiddleware = usageTracker(this.db);

    apiRouter.use(requireAuth(this.authClient));
    apiRouter.use(rateLimiter);
    apiRouter.use(usageTrackerMiddleware);

    // Mount route modules
    apiRouter.use('/projects', createProjectRoutes(projectService));
    apiRouter.use('/tasks', createTaskRoutes(taskService, this.io));
    apiRouter.use('/runs', createRunRoutes(runService));
    apiRouter.use('/schedules', createScheduleRoutes(scheduleService));
    apiRouter.use('/waitpoints', createWaitpointRoutes(waitpointService));
    apiRouter.use('/environments', createEnvironmentRoutes(this.config.trigger));
    apiRouter.use('/deployments', createDeploymentRoutes(deploymentService));
    apiRouter.use('/queues', createQueueRoutes(queueService));
    apiRouter.use('/integrations', createIntegrationRoutes(integrationConfigRepo, this.config));

    this.app.use('/trigger/api/v1', apiRouter);

    logger.info('API routes mounted at /trigger/api/v1');
  }

  private setupUI(): void {
    const uiBuildPath = path.resolve(this.config.plugin.uiBuildPath || './ui/out');

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

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
import { QuotaEnforcer, quotaEnforcerMiddleware } from './middleware/quota-enforcer';
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
import { createSettingsRouter } from './api/settings';
import { createWorkflowRouter, createJobRouter } from './api/workflows';
import { createErrorRouter } from './api/errors';
import { createLogRouter } from './api/logs';
import { createBatchRouter } from './api/batches';
import { createAuthEventsRouter } from './api/auth-events';

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
import { ScheduleExecutorService } from './services/schedule-executor.service';
import { WorkflowService } from './services/workflow.service';
import { WorkflowExecutor } from './services/workflow-executor';

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
import { WorkflowRepository } from './database/repositories/workflow.repository';
import { ErrorRepository } from './database/repositories/error.repository';
import { LogRepository } from './database/repositories/log.repository';
import { BatchRepository } from './database/repositories/batch.repository';

// Import Trigger.dev client factory
import { createTriggerClients } from './config/trigger-client';

// Import integration clients and health worker
import { buildClientRegistry, ServiceClientRegistry } from './services/client-registry';
import { HealthWorkerService } from './services/health-worker.service';
import type { ServiceName } from './database/repositories/integration-config.repository';

// Static task definition registry — seeded on startup so Tasks page is populated
import { TASK_REGISTRY, toUpsertData } from './task-definitions/registry';

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
  private healthWorker: HealthWorkerService;
  private clientRegistry: ServiceClientRegistry;
  private scheduleExecutor: ScheduleExecutorService;
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

    // Initialize sync service, schedule executor, and health worker (placeholders - wired in start())
    this.syncService = null as any;
    this.scheduleExecutor = null as any;
    this.healthWorker = null as any;
    this.clientRegistry = new Map();
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
      const errorRepo = new ErrorRepository(this.db);
      const logRepo = new LogRepository(this.db);
      const batchRepo = new BatchRepository(this.db);

      // Initialize Trigger.dev SDK and Management API client
      const triggerClients = createTriggerClients(this.config.trigger);

      // Initialize Trigger.dev proxy service
      const triggerProxy = new TriggerProxyService(triggerClients.managementApi);

      // Build integration client registry (all 10 clients)
      this.clientRegistry = buildClientRegistry(this.config.nexus.services, 'system');
      logger.info('Integration client registry built', {
        clients: Array.from(this.clientRegistry.keys()),
      });

      // Auto-seed integration configs with correct URLs for all orgs
      await this.seedIntegrationConfigs(integrationConfigRepo);

      // Seed task definitions from static registry so Tasks page is populated
      await this.seedTaskDefinitions(taskDefRepo);

      // Initialize services (match actual constructor signatures)
      const projectService = new ProjectService(projectRepo, usageRepo);
      // Wire logRepo into RunStreamManager (created before DB init)
      this.runStreamManager.setLogRepo(logRepo);

      const taskService = new TaskService(
        triggerProxy,
        projectRepo,
        runRepo,
        taskDefRepo,
        usageRepo,
        this.config.nexus,
        this.io,
        this.runStreamManager,
        logRepo,
        this.db.getPool(),
        this.redis,
      );
      const runService = new RunService(triggerProxy, runRepo, this.io, scheduleRepo, waitpointRepo);
      const scheduleService = new ScheduleService(scheduleRepo, usageRepo, this.io);

      // Create in-process schedule executor (local cron engine — no Trigger.dev cloud needed)
      this.scheduleExecutor = new ScheduleExecutorService(
        scheduleRepo, taskService, this.io, this.db, this.redis
      );
      scheduleService.setExecutor(this.scheduleExecutor);
      const waitpointService = new WaitpointService(triggerProxy, waitpointRepo, usageRepo, this.io);
      const deploymentService = new DeploymentService(triggerProxy, this.db);
      const queueService = new QueueService(triggerProxy, this.io);
      const workflowRepo = new WorkflowRepository(this.db);
      const workflowExecutor = new WorkflowExecutor(
        workflowRepo,
        triggerProxy,
        this.clientRegistry,
        this.io,
        runRepo,
        logRepo
      );
      const workflowService = new WorkflowService(workflowRepo, this.io, workflowExecutor);
      this.syncService = new SyncService(triggerProxy, runRepo, logRepo);

      // Setup middleware
      this.setupMiddleware();

      // Setup health endpoints (no auth required)
      this.setupHealthEndpoints();

      // Setup metrics endpoint
      this.setupMetricsEndpoint();

      // Setup auth event webhook (HMAC-verified, no JWT — must be before auth middleware)
      this.setupAuthEventWebhook(this.db.getPool());

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
        taskTemplateRepo,
        this.clientRegistry,
        projectRepo,
        workflowService,
        errorRepo,
        logRepo,
        batchRepo
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

      // Start in-process schedule executor (loads all enabled schedules from DB)
      await this.scheduleExecutor.start();

      // Seed default schedules (platform-knowledge-sync) if not already present
      await this.seedDefaultSchedules(scheduleRepo);

      // Start background health check worker (every 60 seconds)
      this.healthWorker = new HealthWorkerService(
        integrationConfigRepo,
        this.clientRegistry,
        this.io,
        60000
      );
      this.healthWorker.start();

      // Recover orphaned Skills Engine runs from previous pod lifecycle
      taskService.recoverOrphanedSkillsEngineRuns().then(count => {
        if (count > 0) {
          logger.warn(`Recovered ${count} orphaned Skills Engine run(s) from previous pod lifecycle`);
        }
      }).catch(err => {
        logger.error('Failed to recover orphaned Skills Engine runs', { error: err.message });
      });

      // Recover stale workflow runs from previous pod lifecycle
      workflowService.recoverStaleRuns().then(count => {
        if (count > 0) {
          logger.warn(`Recovered ${count} stale workflow run(s) from previous pod lifecycle`);
        }
      }).catch(err => {
        logger.error('Failed to recover stale runs on startup', { error: err.message });
      });

      // Periodic sweep for stuck workflow runs (every 60s)
      setInterval(async () => {
        try {
          const count = await workflowService.recoverStaleRuns(30);
          if (count > 0) {
            logger.warn(`Periodic sweep recovered ${count} stale workflow run(s)`);
          }
        } catch (err: any) {
          logger.error('Stale run sweep failed', { error: err.message });
        }
      }, 60_000);

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

    // Body parsing (verify callback preserves raw body for webhook HMAC verification)
    this.app.use(express.json({
      limit: '10mb',
      verify: (req: any, _res, buf) => {
        if (req.url?.startsWith('/trigger/webhooks')) {
          req.rawBody = buf;
        }
      },
    }));
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
          // triggerApiUrl omitted — trigger-dev-webapp is not deployed in this cluster
          memoryThreshold: 95,
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

  private setupAuthEventWebhook(pool: any): void {
    // Auth event webhooks are HMAC-verified (no JWT required)
    // Mounted before the auth-protected API routes
    this.app.use('/trigger/webhooks', createAuthEventsRouter(pool));
    logger.info('Auth event webhook endpoint mounted at /trigger/webhooks/auth-events');
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
    taskTemplateRepo: TaskTemplateRepository,
    clientRegistry: ServiceClientRegistry,
    projectRepo: ProjectRepository,
    workflowService: WorkflowService,
    errorRepo: ErrorRepository,
    logRepo: LogRepository,
    batchRepo: BatchRepository
  ): void {
    const apiRouter = express.Router();

    // Apply auth middleware to all API routes
    const limiters = createRateLimiter(this.redis);
    const quotaEnforcer = new QuotaEnforcer(this.redis);
    const usageTrackerMiddleware = usageTracker(this.db.getPool());

    apiRouter.use(requireAuth(this.authClient));
    apiRouter.use(rateLimiter(limiters));
    apiRouter.use(usageTrackerMiddleware);

    // Quota enforcement on execution-triggering routes (check before handler runs)
    apiRouter.post('/workflows/:wid/run', quotaEnforcerMiddleware(quotaEnforcer, 'concurrent_runs'));
    apiRouter.post('/tasks/:taskId/trigger', quotaEnforcerMiddleware(quotaEnforcer, 'tasks_per_minute'));
    apiRouter.post('/schedules', quotaEnforcerMiddleware(quotaEnforcer, 'schedules'));

    // Mount route modules (match actual function signatures)
    apiRouter.use('/projects', createProjectRouter(projectService, this.io));
    apiRouter.use('/tasks', createTaskRouter(taskService, this.io));
    apiRouter.use('/runs', createRunRouter(runService, this.io));
    apiRouter.use('/schedules', createScheduleRouter(scheduleService, this.io, projectRepo));
    apiRouter.use('/waitpoints', createWaitpointRouter(waitpointService, this.io));
    apiRouter.use('/environments', createEnvironmentRouter(triggerProxy));
    apiRouter.use('/deployments', createDeploymentRouter(deploymentService));
    apiRouter.use('/queues', createQueueRouter(queueService, this.io));
    apiRouter.use('/integrations', createIntegrationRouter(integrationConfigRepo, this.config.nexus, this.io, taskTemplateRepo, clientRegistry));
    apiRouter.use('/settings', createSettingsRouter(this.db));
    apiRouter.use('/workflows', createWorkflowRouter(workflowService, this.io));
    apiRouter.use('/jobs', createJobRouter(workflowService));
    apiRouter.use('/errors', createErrorRouter(errorRepo));
    apiRouter.use('/logs', createLogRouter(logRepo));
    apiRouter.use('/batches', createBatchRouter(batchRepo, taskService, runService));

    // Internal service-to-service webhook (no JWT, service-key auth only)
    // Used by nexus-plugins to trigger platform-knowledge-refresh on plugin changes
    this.app.post('/trigger/internal/tasks/:taskId/trigger', async (req, res) => {
      const serviceKey = req.headers['x-service-key'] as string;
      const expectedKey = process.env.INTERNAL_SERVICE_KEY;

      if (!expectedKey || serviceKey !== expectedKey) {
        return res.status(401).json({ error: 'Invalid service key' });
      }

      const { taskId } = req.params;
      const payload = req.body?.payload || {};

      try {
        const projects = await this.db.getPool().query(
          'SELECT project_id, organization_id FROM trigger.projects LIMIT 1'
        );
        if (projects.rows.length === 0) {
          return res.status(500).json({ error: 'No projects configured' });
        }
        const { project_id, organization_id } = projects.rows[0];

        const result = await taskService.triggerTask(
          organization_id, 'system', project_id, taskId, payload
        );
        res.status(201).json({ success: true, data: result });
      } catch (err: any) {
        logger.error('Internal task trigger failed', { taskId, error: err.message });
        res.status(500).json({ error: err.message });
      }
    });

    // Internal run status endpoint (service-key auth, no JWT required)
    // Used by nexus-prosecreator to poll forge job run status
    this.app.get('/trigger/internal/runs/:runId', async (req, res) => {
      const serviceKey = req.headers['x-service-key'] as string;
      const expectedKey = process.env.INTERNAL_SERVICE_KEY;

      if (!expectedKey || serviceKey !== expectedKey) {
        return res.status(401).json({ error: 'Invalid service key' });
      }

      const { runId } = req.params;

      try {
        // Direct DB lookup without orgId — trusted service-to-service call
        const row = await this.db.getPool().query(
          `SELECT run_id, task_identifier, status, output, error_message,
                  started_at, completed_at, duration_ms, payload
           FROM trigger.run_history WHERE run_id = $1`,
          [runId]
        );

        if (row.rows.length === 0) {
          return res.status(404).json({ error: 'Run not found' });
        }

        const run = row.rows[0];
        res.json({
          id: run.run_id,
          taskId: run.task_identifier,
          status: run.status,
          output: run.output,
          error: run.error_message,
          errorMessage: run.error_message,
          startedAt: run.started_at,
          completedAt: run.completed_at,
          durationMs: run.duration_ms,
        });
      } catch (err: any) {
        logger.error('Internal run status lookup failed', { runId, error: err.message });
        res.status(500).json({ error: err.message });
      }
    });

    // Internal batch trigger endpoint (service-key auth, no JWT required)
    // Used by nexus-prosecreator for parallel LLM calls in Full Extract Pipeline
    this.app.post('/trigger/internal/batches/trigger', async (req, res) => {
      const serviceKey = req.headers['x-service-key'] as string;
      const expectedBatchKey = process.env.INTERNAL_SERVICE_KEY;

      if (!expectedBatchKey || serviceKey !== expectedBatchKey) {
        return res.status(401).json({ error: 'Invalid service key' });
      }

      const { items, name } = req.body;
      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'items[] is required and must not be empty' });
      }
      if (items.length > 500) {
        return res.status(400).json({ error: 'Maximum 500 items per batch' });
      }

      try {
        const projects = await this.db.getPool().query(
          'SELECT project_id, organization_id FROM trigger.projects LIMIT 1'
        );
        if (projects.rows.length === 0) {
          return res.status(500).json({ error: 'No projects configured' });
        }
        const { project_id, organization_id } = projects.rows[0];

        const batch = await batchRepo.create(organization_id, name);
        const results: { taskIdentifier: string; runId?: string; error?: string }[] = [];

        for (const item of items) {
          try {
            const run = await taskService.triggerTask(
              organization_id, 'system', project_id, item.taskIdentifier, item.payload || {}
            );
            if (run?.runId) {
              await batchRepo.linkRun(run.runId, batch.batchId);
            }
            results.push({ taskIdentifier: item.taskIdentifier, runId: run?.localRunId || run?.runId });
          } catch (err: any) {
            results.push({ taskIdentifier: item.taskIdentifier, error: err.message });
          }
        }

        const updated = await batchRepo.updateCounts(batch.batchId);

        logger.info('Internal batch triggered', {
          batchId: batch.batchId,
          total: items.length,
          succeeded: results.filter(r => !r.error).length,
          failed: results.filter(r => r.error).length,
        });

        res.status(201).json({ success: true, data: { ...updated, results } });
      } catch (err: any) {
        logger.error('Internal batch trigger failed', { error: err.message });
        res.status(500).json({ error: err.message });
      }
    });

    // Internal batch status endpoint (service-key auth, no JWT required)
    this.app.get('/trigger/internal/batches/:batchId', async (req, res) => {
      const serviceKey = req.headers['x-service-key'] as string;
      const expectedBatchKey = process.env.INTERNAL_SERVICE_KEY;

      if (!expectedBatchKey || serviceKey !== expectedBatchKey) {
        return res.status(401).json({ error: 'Invalid service key' });
      }

      const { batchId } = req.params;

      try {
        // Direct DB lookup — trusted service-to-service call, no orgId needed
        const row = await this.db.getPool().query(
          `SELECT b.*,
            (SELECT json_agg(json_build_object(
              'runId', rh.run_id, 'taskId', rh.task_identifier, 'status', rh.status,
              'output', rh.output, 'error', rh.error_message,
              'startedAt', rh.started_at, 'completedAt', rh.completed_at, 'durationMs', rh.duration_ms
            )) FROM trigger.run_history rh WHERE rh.batch_id = b.batch_id) as runs
           FROM trigger.batches b WHERE b.batch_id = $1`,
          [batchId]
        );
        if (row.rows.length === 0) {
          return res.status(404).json({ error: 'Batch not found' });
        }
        const batch = row.rows[0];
        res.json({
          success: true,
          data: {
            batchId: batch.batch_id,
            name: batch.name,
            totalRuns: parseInt(batch.total_runs || '0', 10),
            completedRuns: parseInt(batch.completed_runs || '0', 10),
            failedRuns: parseInt(batch.failed_runs || '0', 10),
            status: batch.status,
            createdAt: batch.created_at,
            completedAt: batch.completed_at,
            runs: batch.runs || [],
          },
        });
      } catch (err: any) {
        logger.error('Internal batch status failed', { batchId, error: err.message });
        res.status(500).json({ error: err.message });
      }
    });

    this.app.use('/trigger/api/v1', apiRouter);

    logger.info('API routes mounted at /trigger/api/v1');
  }

  /**
   * Seed integration configs with correct default URLs for services
   * that don't yet have DB rows. Also fixes empty service_url for existing rows.
   */
  private async seedIntegrationConfigs(
    integrationConfigRepo: IntegrationConfigRepository
  ): Promise<void> {
    const services = this.config.nexus.services;

    // Map config keys to service names used in DB
    const serviceMapping: Array<{ dbName: ServiceName; configKey: keyof typeof services; deployed: boolean }> = [
      { dbName: 'graphrag', configKey: 'graphrag', deployed: true },
      { dbName: 'mageagent', configKey: 'mageagent', deployed: true },
      { dbName: 'fileprocess', configKey: 'fileprocess', deployed: true },
      { dbName: 'learningagent', configKey: 'learningagent', deployed: true },
      { dbName: 'geoagent', configKey: 'geoagent', deployed: true },
      { dbName: 'jupyter', configKey: 'jupyter', deployed: true },
      { dbName: 'cvat', configKey: 'cvat', deployed: true },
      { dbName: 'gpu-bridge', configKey: 'gpuBridge', deployed: false },
      { dbName: 'sandbox', configKey: 'sandbox', deployed: false },
      { dbName: 'n8n', configKey: 'n8n', deployed: true },
      { dbName: 'skills-engine', configKey: 'skillsEngine', deployed: true },
    ];

    // Use a system org ID for seeding — real orgs get their rows when they first access
    // We seed for ALL existing orgs in the integration_configs table
    // First, get all known org IDs
    let orgIds: string[] = [];
    try {
      const rows = await this.db.getPool().query(
        `SELECT DISTINCT organization_id FROM trigger.integration_configs`
      );
      orgIds = rows.rows.map((r: any) => r.organization_id);
    } catch {
      // Table might be empty
    }

    // If no orgs exist yet, nothing to seed
    if (orgIds.length === 0) {
      logger.info('No existing orgs found, skipping integration seed');
      return;
    }

    let seeded = 0;
    let updated = 0;

    for (const orgId of orgIds) {
      for (const { dbName, configKey, deployed } of serviceMapping) {
        const url = services[configKey];

        try {
          const existing = await integrationConfigRepo.findByService(orgId, dbName);

          if (!existing) {
            // Insert new row
            await integrationConfigRepo.upsert(orgId, dbName, {
              enabled: deployed && !!url,
              serviceUrl: url || '',
            });
            seeded++;
          } else if (!existing.serviceUrl && url) {
            // Fix empty URL
            await integrationConfigRepo.upsert(orgId, dbName, {
              serviceUrl: url,
              enabled: deployed,
            });
            updated++;
          }
        } catch (err: any) {
          logger.warn(`Failed to seed ${dbName} for org ${orgId}`, { error: err.message });
        }
      }
    }

    logger.info('Integration configs seeded', { seeded, updated, orgs: orgIds.length });
  }

  /**
   * Seed task definitions from the static registry for every org/project pair.
   * Uses ON CONFLICT to skip already-existing rows.
   */
  private async seedTaskDefinitions(
    taskDefRepo: TaskDefinitionRepository
  ): Promise<void> {
    try {
      const projects = await this.db.getPool().query(
        `SELECT project_id, organization_id FROM trigger.projects`
      );

      if (projects.rows.length === 0) {
        logger.info('No projects found, skipping task definition seed');
        return;
      }

      let seeded = 0;
      for (const proj of projects.rows) {
        for (const entry of TASK_REGISTRY) {
          try {
            await taskDefRepo.upsert(
              toUpsertData(entry, proj.project_id, proj.organization_id)
            );
            seeded++;
          } catch {
            // ON CONFLICT — already exists, skip
          }
        }
      }

      logger.info('Task definitions seeded from registry', {
        total: seeded,
        registry: TASK_REGISTRY.length,
        projects: projects.rows.length,
      });
    } catch (err: any) {
      logger.warn('Failed to seed task definitions', { error: err.message });
    }
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

  private async seedDefaultSchedules(scheduleRepo: ScheduleRepository): Promise<void> {
    try {
      // Get first project for org context
      const projects = await this.db.getPool().query(
        'SELECT project_id, organization_id, user_id FROM trigger.projects LIMIT 1'
      );
      if (projects.rows.length === 0) {
        logger.warn('No projects found — skipping default schedule seeding');
        return;
      }
      const { project_id, organization_id, user_id } = projects.rows[0];

      // Check if platform-knowledge-sync schedule already exists
      const existing = await scheduleRepo.findByOrgId(organization_id, {
        taskIdentifier: 'platform-knowledge-sync',
      });
      if (existing.length > 0) {
        logger.info('platform-knowledge-sync schedule already exists', {
          scheduleId: existing[0].scheduleId,
          enabled: existing[0].enabled,
        });
      } else {

      // Create the default schedule
      const schedule = await scheduleRepo.create({
        projectId: project_id,
        organizationId: organization_id,
        userId: user_id,
        taskIdentifier: 'platform-knowledge-sync',
        cronExpression: '0 3 * * *',
        timezone: 'UTC',
        description: 'Daily platform knowledge sync — catalogs all plugins and skills',
        payload: { reason: 'scheduled-daily' },
      });

      // Register with executor
      this.scheduleExecutor.addSchedule(schedule);

      logger.info('Seeded platform-knowledge-sync schedule', {
        scheduleId: schedule.scheduleId,
        cron: '0 3 * * *',
      });
      }
    } catch (err: any) {
      logger.error('Failed to seed default schedules', { error: err.message });
    }

    // --- Platform Health Monitor (every 30 minutes) ---
    try {
      const projects = await this.db.getPool().query(
        'SELECT project_id, organization_id, user_id FROM trigger.projects LIMIT 1'
      );
      if (projects.rows.length === 0) return;
      const { project_id, organization_id, user_id } = projects.rows[0];

      const existing = await scheduleRepo.findByOrgId(organization_id, {
        taskIdentifier: 'platform-health-monitor',
      });
      if (existing.length > 0) {
        logger.info('platform-health-monitor schedule already exists', {
          scheduleId: existing[0].scheduleId,
          enabled: existing[0].enabled,
        });
        return;
      }

      const healthSchedule = await scheduleRepo.create({
        projectId: project_id,
        organizationId: organization_id,
        userId: user_id,
        taskIdentifier: 'platform-health-monitor',
        cronExpression: '*/30 * * * *',
        timezone: 'UTC',
        description: 'Platform health monitor — checks all services, pods, databases every 30 minutes',
        payload: { reason: 'scheduled-30m' },
      });

      this.scheduleExecutor.addSchedule(healthSchedule);

      logger.info('Seeded platform-health-monitor schedule', {
        scheduleId: healthSchedule.scheduleId,
        cron: '*/30 * * * *',
      });
    } catch (err: any) {
      logger.error('Failed to seed platform-health-monitor schedule', { error: err.message });
    }

    // --- User Event Daily Digest (8 AM UTC) ---
    try {
      const projects = await this.db.getPool().query(
        'SELECT project_id, organization_id, user_id FROM trigger.projects LIMIT 1'
      );
      if (projects.rows.length === 0) return;
      const { project_id, organization_id, user_id } = projects.rows[0];

      const existing = await scheduleRepo.findByOrgId(organization_id, {
        taskIdentifier: 'user-event-daily-digest',
      });
      if (existing.length > 0) {
        logger.info('user-event-daily-digest schedule already exists', {
          scheduleId: existing[0].scheduleId,
          enabled: existing[0].enabled,
        });
        return;
      }

      const digestSchedule = await scheduleRepo.create({
        projectId: project_id,
        organizationId: organization_id,
        userId: user_id,
        taskIdentifier: 'user-event-daily-digest',
        cronExpression: '0 8 * * *',
        timezone: 'UTC',
        description: 'Daily user event digest — summarizes signups, logins, subscription changes, security alerts',
        payload: { reason: 'scheduled-daily-digest' },
      });

      this.scheduleExecutor.addSchedule(digestSchedule);

      logger.info('Seeded user-event-daily-digest schedule', {
        scheduleId: digestSchedule.scheduleId,
        cron: '0 8 * * *',
      });
    } catch (err: any) {
      logger.error('Failed to seed user-event-daily-digest schedule', { error: err.message });
    }
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

      // Stop schedule executor
      if (this.scheduleExecutor) {
        this.scheduleExecutor.stop();
      }

      // Stop health worker
      if (this.healthWorker) {
        this.healthWorker.stop();
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

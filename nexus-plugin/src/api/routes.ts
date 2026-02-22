import { Router } from 'express';
import { Server as SocketIOServer } from 'socket.io';
import { NexusAuthClient } from '../auth/nexus-auth-client';
import { requireAuth } from '../middleware/auth';
import { ProjectService } from '../services/project.service';
import { TaskService } from '../services/task.service';
import { RunService } from '../services/run.service';
import { ScheduleService } from '../services/schedule.service';
import { WaitpointService } from '../services/waitpoint.service';
import { DeploymentService } from '../services/deployment.service';
import { QueueService } from '../services/queue.service';
import { SyncService } from '../services/sync.service';
import { TriggerProxyService } from '../services/trigger-proxy.service';
import { IntegrationConfigRepository } from '../database/repositories/integration-config.repository';
import { NexusConfig } from '../config';
import { createProjectRouter } from './projects';
import { createTaskRouter } from './tasks';
import { createRunRouter } from './runs';
import { createScheduleRouter } from './schedules';
import { createWaitpointRouter } from './waitpoints';
import { createEnvironmentRouter } from './environments';
import { createDeploymentRouter } from './deployments';
import { createQueueRouter } from './queues';
import { createIntegrationRouter } from './integrations';

export interface RouterDependencies {
  authClient: NexusAuthClient;
  io: SocketIOServer;
  projectService: ProjectService;
  taskService: TaskService;
  runService: RunService;
  scheduleService: ScheduleService;
  waitpointService: WaitpointService;
  deploymentService: DeploymentService;
  queueService: QueueService;
  syncService: SyncService;
  triggerProxy: TriggerProxyService;
  integrationConfigRepo: IntegrationConfigRepository;
  nexusConfig: NexusConfig;
}

export function createApiRouter(deps: RouterDependencies): Router {
  const router = Router();

  const auth = requireAuth(deps.authClient);

  // All routes require authentication
  router.use(auth);

  // Mount sub-routers
  router.use('/projects', createProjectRouter(deps.projectService, deps.io));
  router.use('/tasks', createTaskRouter(deps.taskService, deps.io));
  router.use('/runs', createRunRouter(deps.runService, deps.io));
  router.use('/schedules', createScheduleRouter(deps.scheduleService, deps.io));
  router.use('/waitpoints', createWaitpointRouter(deps.waitpointService, deps.io));
  router.use('/environments', createEnvironmentRouter(deps.triggerProxy));
  router.use('/deployments', createDeploymentRouter(deps.deploymentService));
  router.use('/queues', createQueueRouter(deps.queueService, deps.io));
  router.use(
    '/integrations',
    createIntegrationRouter(deps.integrationConfigRepo, deps.nexusConfig, deps.io)
  );

  return router;
}

export default createApiRouter;
